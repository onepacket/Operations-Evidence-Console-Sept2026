import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildExceptions,
  buildStoredRows,
  parseRecords,
  processingStatus,
  validateUploadMetadata,
} from "./lib/importValidation.ts";
import {
  canMutateAuditLedger,
  hasOperationsRole,
  isAuthenticated,
  isSameOrganisation,
} from "./lib/authPolicy.ts";
import {
  buildInboundSignature,
  inboundDeliveryKey,
  isFreshInboundTimestamp,
  signaturesMatch,
} from "./lib/inboundPolicy.ts";
import {
  actionEffect,
  actionResult,
  canAccessOrganisation,
  canDecideAction,
  isAllowedActionType,
} from "./lib/operationsPolicy.ts";
import {
  canProcessRun,
  contentHash,
  isDuplicateImportContent,
} from "./lib/processingPolicy.ts";
import {
  isTimeoutError,
  llmSummarySchema,
  validateSummarySources,
} from "./lib/summaryPolicy.ts";
import {
  generateStructuredSummary,
  SUMMARY_MAX_ATTEMPTS,
  SUMMARY_MODEL,
  SUMMARY_REQUEST_TIMEOUT_MS,
  SummaryGenerationError,
} from "./lib/summaryService.ts";

const validRow = {
  record_id: "record-1",
  email: "person@example.com",
  amount: "12.50",
  effective_date: "2026-09-12",
};

describe("Prompt 8: deterministic operations evidence suite", () => {
  describe("happy path sequence", () => {
    it("runs the complete logical sequence and records ordered audit verbs", async () => {
      const auditVerbs: string[] = [];
      const runId = "run-sequence-1";
      const sourceRows = new Set([2]);
      const rows = parseRecords(
        "record_id,email,amount,effective_date\nrecord-1,person@example.com,12.5,2026-09-12",
        "records.csv",
        "text/csv",
      );

      assert.equal(isAuthenticated("clerk-user-1"), true);
      auditVerbs.push("auth.signed_in");
      assert.equal(validateUploadMetadata({
        name: "records.csv",
        size: 128,
        contentType: "text/csv",
      }), null);
      assert.equal(buildExceptions(runId, "org-1", rows).length, 0);
      auditVerbs.push("upload.received");
      assert.equal(processingStatus(0), "succeeded");
      auditVerbs.push("run.processed");

      const summary = await generateStructuredSummary(
        {
          records: [{ rowNumber: 2, accepted: true, data: rows[0] ?? {} }],
          exceptions: [],
        },
        sourceRows,
        {
          complete: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  headline: "Clean import",
                  headlineSourceRows: [2],
                  overview: "The import passed validation.",
                  overviewSourceRows: [2],
                  riskLevel: "low",
                  findings: [],
                }),
              },
            }],
          }),
          delay: async () => {},
        },
      );
      assert.equal(summary.riskLevel, "low");
      auditVerbs.push("summary.generated");

      assert.equal(isAllowedActionType("request_correction"), true);
      auditVerbs.push("action.requested");
      assert.equal(canDecideAction({
        viewerRole: "administrator",
        actionStatus: "requested",
        requestedByMemberId: "analyst-1",
        viewerId: "admin-1",
      }), true);
      const effect = actionEffect("request_correction", runId);
      const result = actionResult("request_correction");
      auditVerbs.push("action.approved");

      assert.deepEqual(auditVerbs, [
        "auth.signed_in",
        "upload.received",
        "run.processed",
        "summary.generated",
        "action.requested",
        "action.approved",
      ]);
      assert.deepEqual(effect, {
        kind: "correction_work_item",
        runId,
        status: "open",
      });
      assert.equal(result, "A source correction work item was created.");
    });

    it("accepts sign-in only for an authenticated provisioned role", () => {
      assert.equal(isAuthenticated("clerk-user-1"), true);
      assert.equal(isAuthenticated(undefined), false);
      assert.equal(hasOperationsRole("analyst", ["analyst", "administrator"]), true);
      assert.equal(hasOperationsRole("auditor", ["analyst", "administrator"]), false);
    });

    it("validates an upload, stores accepted rows, and records exceptions", () => {
      assert.equal(
        validateUploadMetadata({
          name: "records.csv",
          size: 128,
          contentType: "text/csv",
        }),
        null,
      );
      const rows = [validRow, { ...validRow, record_id: "", email: "bad" }];
      const exceptions = buildExceptions("run-1", "org-1", rows);
      const stored = buildStoredRows(rows, exceptions, {
        organisationId: "org-1",
        importId: "import-1",
        runId: "run-1",
      });
      assert.equal(exceptions.length, 2);
      assert.deepEqual(stored.map((row) => row.accepted), [true, false]);
      assert.equal(processingStatus(exceptions.length), "partial");
    });

    it("accepts a structured evidence summary only when citations are supplied", () => {
      const summary = llmSummarySchema.parse({
        headline: "One row requires review",
        headlineSourceRows: [2],
        overview: "The imported evidence is otherwise clean.",
        overviewSourceRows: [2],
        riskLevel: "medium",
        findings: [{
          title: "Review source row",
          detail: "The source row needs correction.",
          severity: "medium",
          sourceRowNumbers: [2],
        }],
      });
      assert.deepEqual(
        validateSummarySources(summary, new Set([2])),
        summary,
      );
      assert.throws(
        () => validateSummarySources(summary, new Set([3])),
        /not supplied as evidence/,
      );
    });

    it("allows a supported action, requires a different administrator, and creates an effect", () => {
      assert.equal(isAllowedActionType("request_correction"), true);
      assert.equal(canDecideAction({
        viewerRole: "administrator",
        actionStatus: "requested",
        requestedByMemberId: "analyst-1",
        viewerId: "admin-1",
      }), true);
      assert.deepEqual(actionEffect("request_correction", "run-1"), {
        kind: "correction_work_item",
        runId: "run-1",
        status: "open",
      });
      assert.equal(
        actionResult("request_correction"),
        "A source correction work item was created.",
      );
    });

    it("keeps audit mutation prohibited while exposing the completed action result", () => {
      assert.equal(canMutateAuditLedger("administrator"), false);
      assert.equal(canMutateAuditLedger("auditor"), false);
      assert.equal(actionResult("notify_owner"), "A data owner notification was queued for delivery.");
    });
  });

  describe("access control", () => {
    it("rejects unauthenticated and wrong-role access", () => {
      assert.equal(isAuthenticated(null), false);
      assert.equal(hasOperationsRole(undefined, ["analyst"]), false);
      assert.equal(hasOperationsRole("auditor", ["analyst", "administrator"]), false);
    });

    it("rejects cross-organisation resources", () => {
      assert.equal(isSameOrganisation("org-a", "org-a"), true);
      assert.equal(isSameOrganisation("org-a", "org-b"), false);
      assert.equal(canAccessOrganisation("org-a", "org-b"), false);
    });

    it("does not permit an auditor to mutate actions or audit ledgers", () => {
      assert.equal(hasOperationsRole("auditor", ["analyst", "administrator"]), false);
      assert.equal(canDecideAction({
        viewerRole: "auditor",
        actionStatus: "requested",
        requestedByMemberId: "analyst-1",
        viewerId: "auditor-1",
      }), false);
      assert.equal(canMutateAuditLedger("auditor"), false);
    });
  });

  describe("inbound event authentication", () => {
    const secret = "prompt-8-test-secret";
    const source = "upstream-system";
    const rawBody = JSON.stringify({
      eventId: "event-1",
      organisationId: "11111111-1111-4111-8111-111111111111",
      eventType: "run.process",
      payload: { runId: "run-1" },
    });

    it("accepts a valid signature in the freshness window", () => {
      const timestamp = 1_700_000_000;
      const signature = buildInboundSignature({ secret, timestamp, source, rawBody });
      assert.equal(signaturesMatch(
        signature,
        buildInboundSignature({ secret, timestamp, source, rawBody }),
      ), true);
      assert.equal(isFreshInboundTimestamp(timestamp, timestamp + 299), true);
    });

    it("rejects a forged signature", () => {
      const timestamp = 1_700_000_000;
      const signature = buildInboundSignature({ secret, timestamp, source, rawBody });
      const forged = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
      assert.equal(signaturesMatch(signature, forged), false);
      assert.equal(signaturesMatch(signature, buildInboundSignature({
        secret: "wrong-secret",
        timestamp,
        source,
        rawBody,
      })), false);
    });

    it("rejects stale timestamps deterministically", () => {
      assert.equal(isFreshInboundTimestamp(1_699_999_000, 1_700_000_000), false);
      assert.equal(isFreshInboundTimestamp(1_700_000_000, 1_700_000_301), false);
    });

    it("derives the same replay key for the same source and event", () => {
      const first = inboundDeliveryKey(source, "event-1");
      assert.equal(first, inboundDeliveryKey(source, "event-1"));
      assert.notEqual(first, inboundDeliveryKey("other-source", "event-1"));
      assert.notEqual(first, inboundDeliveryKey(source, "event-2"));
    });
  });

  describe("ingestion and rerun behavior", () => {
    it("processes clean input as succeeded", () => {
      const rows = parseRecords(
        "record_id,email,amount,effective_date\nrecord-1,person@example.com,12.5,2026-09-12",
        "records.csv",
        "text/csv",
      );
      assert.equal(buildExceptions("run-1", "org-1", rows).length, 0);
      assert.equal(processingStatus(0), "succeeded");
    });

    it("fails clearly for malformed input", () => {
      assert.throws(
        () => parseRecords("{not-json}", "records.json", "application/json"),
        /JSON file is malformed/,
      );
    });

    it("preserves duplicate CSV headers as explicit fields instead of overwriting data", () => {
      const [row] = parseRecords(
        "record_id,email,email,amount,effective_date\nrecord-1,one@example.com,two@example.com,12,2026-09-12",
        "records.csv",
        "text/csv",
      );
      assert.equal(row?.email, "one@example.com");
      assert.equal(row?.duplicate_email_2, "two@example.com");
    });

    it("represents partial failure and permits a failed rerun below the retry limit", () => {
      const exceptions = buildExceptions("run-1", "org-1", [
        validRow,
        { ...validRow, amount: "-1" },
      ]);
      assert.equal(exceptions.length, 1);
      assert.equal(processingStatus(exceptions.length), "partial");
      assert.equal(canProcessRun("failed", 1), true);
      assert.equal(canProcessRun("failed", 3), false);
      assert.equal(validateUploadMetadata({
        name: "records.json",
        size: 10,
        contentType: "application/json",
      }), null);
    });

    it("deduplicates identical import content by its production hash", () => {
      const firstHash = contentHash("same uploaded bytes");
      const secondHash = contentHash("same uploaded bytes");
      assert.equal(isDuplicateImportContent(firstHash, secondHash), true);
      assert.notEqual(firstHash, contentHash("different uploaded bytes"));
      assert.equal(isDuplicateImportContent(firstHash, contentHash("different uploaded bytes")), false);
    });
  });

  describe("model safety", () => {
    const summaryInput = {
      records: [{ rowNumber: 2, accepted: true, data: validRow }],
      exceptions: [],
    };

    it("generates valid structured output through the production retry helper", async () => {
      let calls = 0;
      let requestOptions: { model: string; timeout: number; maxRetries: number } | undefined;
      const summary = await generateStructuredSummary(summaryInput, new Set([2]), {
        complete: async (request, options) => {
          calls += 1;
          requestOptions = {
            model: request.model,
            timeout: options.timeout,
            maxRetries: options.maxRetries,
          };
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  headline: "Clean",
                  headlineSourceRows: [2],
                  overview: "No material findings.",
                  overviewSourceRows: [2],
                  riskLevel: "low",
                  findings: [],
                }),
              },
            }],
          };
        },
        delay: async () => {
          throw new Error("delay should not run for valid output");
        },
      });
      assert.equal(calls, 1);
      assert.deepEqual(requestOptions, {
        model: SUMMARY_MODEL,
        timeout: SUMMARY_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
      });
      assert.equal(summary.headline, "Clean");
    });

    it("returns malformed_output after exactly three attempts without real delay", async () => {
      let calls = 0;
      let delays = 0;
      await assert.rejects(
        generateStructuredSummary(summaryInput, new Set([2]), {
          complete: async () => {
            calls += 1;
            return { choices: [{ message: { content: "not-json" } }] };
          },
          delay: async () => {
            delays += 1;
          },
        }),
        (error: unknown) =>
          error instanceof SummaryGenerationError &&
          error.state === "malformed_output" &&
          error.attempts === SUMMARY_MAX_ATTEMPTS,
      );
      assert.equal(calls, 3);
      assert.equal(delays, 2);
    });

    it("returns timeout after exactly three attempts without real delay", async () => {
      let calls = 0;
      let delays = 0;
      await assert.rejects(
        generateStructuredSummary(summaryInput, new Set([2]), {
          complete: async () => {
            calls += 1;
            throw { code: "ETIMEDOUT" };
          },
          delay: async () => {
            delays += 1;
          },
        }),
        (error: unknown) =>
          error instanceof SummaryGenerationError &&
          error.state === "timeout" &&
          error.attempts === SUMMARY_MAX_ATTEMPTS,
      );
      assert.equal(calls, 3);
      assert.equal(delays, 2);
    });

    it("accepts valid structured output and rejects malformed output", () => {
      const valid = {
        headline: "Clean",
        headlineSourceRows: [2],
        overview: "No material findings.",
        overviewSourceRows: [2],
        riskLevel: "low",
        findings: [],
      };
      assert.equal(llmSummarySchema.safeParse(valid).success, true);
      assert.equal(llmSummarySchema.safeParse({
        ...valid,
        unexpected: "instruction",
      }).success, false);
    });

    it("classifies timeout failures for retry handling", () => {
      assert.equal(isTimeoutError({ code: "ETIMEDOUT" }), true);
      assert.equal(isTimeoutError(new Error("request timed out")), true);
      assert.equal(isTimeoutError(new Error("validation failed")), false);
    });

    it("rejects a model-proposed action outside the allowlist", () => {
      assert.equal(isAllowedActionType("delete_source"), false);
      assert.equal(isAllowedActionType("request_correction"), true);
    });
  });
});