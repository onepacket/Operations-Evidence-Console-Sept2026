import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";

import {
  actionExecutionsTable,
  actionRequestsTable,
  approvalsTable,
  auditEventsTable,
  db,
  evidenceSummariesTable,
  importRowsTable,
  inboundRefusalAuditTable,
  organisationsTable,
  runsTable,
  validationExceptionsTable,
  type Member,
} from "@workspace/db";
import {
  ApproveActionBody,
  ApproveActionParams,
  ApproveActionResponse,
  CreateRunBody,
  CreateRunResponse,
  GenerateRunSummaryBody,
  GenerateRunSummaryParams,
  GenerateRunSummaryResponse,
  GetCurrentUserResponse,
  GetDashboardResponse,
  GetRunParams,
  GetRunResponse,
  GetRunSummaryParams,
  GetRunSummaryResponse,
  GetSettingsResponse,
  ListActionsQueryParams,
  ListActionsResponse,
  ListAuditEventsQueryParams,
  ListAuditEventsResponse,
  ListRunExceptionsParams,
  ListRunExceptionsResponse,
  ListRunsQueryParams,
  ListRunsResponse,
  ProcessRunParams,
  ProcessRunResponse,
  RejectActionBody,
  RejectActionParams,
  RejectActionResponse,
  RequestActionBody,
  RequestActionResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { isRateLimitError } from "@workspace/integrations-openai-ai-server/batch";

import {
  getOperationsContext,
  requireOperationsAuth,
  requireRole,
} from "../lib/auth";
import { PipelineValidationError } from "../lib/importValidation";
import { processRunForOrganisation } from "../lib/processing";
import { buildRunDetail } from "../lib/runResponses";
import {
  actionEffect,
  actionResult,
  canDecideAction,
  isAllowedActionType,
} from "../lib/operationsPolicy";
import {
  generateStructuredSummary,
  SUMMARY_MODEL,
  SUMMARY_PROMPT_VERSION,
  SummaryGenerationError,
  type SummaryCompletion,
} from "../lib/summaryService";

const router: IRouter = Router();
router.use(requireOperationsAuth);

function runView(run: typeof runsTable.$inferSelect) {
  return {
    id: run.id,
    fileName: run.fileName,
    fileType: run.fileType,
    status: run.status,
    recordCount: run.recordCount,
    exceptionCount: run.exceptionCount,
    retryCount: run.retryCount,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    summaryStatus: run.summaryStatus,
  };
}

function actionView(
  action: typeof actionRequestsTable.$inferSelect,
  viewer?: Member,
) {
  return {
    id: action.id,
    runId: action.runId,
    actionType: action.actionType,
    title: action.title,
    rationale: action.rationale,
    status: action.status,
    requestedBy: action.requestedByMemberId,
    requestedAt: action.requestedAt,
    decidedAt: action.decidedAt,
    decisionNote: action.decisionNote,
    result: action.result,
    canDecide:
      canDecideAction({
        viewerRole: viewer?.role,
        actionStatus: action.status,
        requestedByMemberId: action.requestedByMemberId,
        viewerId: viewer?.id,
      }),
  };
}

function exceptionView(
  exception: typeof validationExceptionsTable.$inferSelect,
) {
  return {
    id: exception.id,
    runId: exception.runId,
    rowNumber: exception.rowNumber,
    field: exception.field,
    code: exception.code,
    message: exception.message,
    severity: exception.severity,
    status: exception.status,
    value: exception.value,
  };
}

router.get("/me", async (req, res): Promise<void> => {
  const { member, organisation } = getOperationsContext(req);
  res.json(
    GetCurrentUserResponse.parse({
      id: member.clerkUserId,
      name: member.name,
      email: member.email,
      role: member.role,
      organisation: {
        id: organisation.id,
        name: organisation.name,
        code: organisation.code,
      },
    }),
  );
});

router.get("/dashboard", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [[exceptions], [runsThisMonth], [pendingActions], [completed], [successful], recentRuns] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(validationExceptionsTable)
        .where(
          and(
            eq(validationExceptionsTable.organisationId, organisation.id),
            eq(validationExceptionsTable.status, "open"),
          ),
        ),
      db
        .select({ value: count() })
        .from(runsTable)
        .where(
          and(
            eq(runsTable.organisationId, organisation.id),
            gte(runsTable.createdAt, monthStart),
          ),
        ),
      db
        .select({ value: count() })
        .from(actionRequestsTable)
        .where(
          and(
            eq(actionRequestsTable.organisationId, organisation.id),
            eq(actionRequestsTable.status, "requested"),
          ),
        ),
      db
        .select({ value: count() })
        .from(runsTable)
        .where(
          and(
            eq(runsTable.organisationId, organisation.id),
            sql`${runsTable.status} in ('succeeded', 'partial', 'failed')`,
          ),
        ),
      db
        .select({ value: count() })
        .from(runsTable)
        .where(
          and(
            eq(runsTable.organisationId, organisation.id),
            eq(runsTable.status, "succeeded"),
          ),
        ),
      db
        .select()
        .from(runsTable)
        .where(eq(runsTable.organisationId, organisation.id))
        .orderBy(desc(runsTable.createdAt))
        .limit(5),
    ]);

  const completedCount = Number(completed?.value ?? 0);
  const successRate =
    completedCount === 0
      ? 0
      : Math.round((Number(successful?.value ?? 0) / completedCount) * 100);

  res.json(
    GetDashboardResponse.parse({
      openExceptions: Number(exceptions?.value ?? 0),
      runsThisMonth: Number(runsThisMonth?.value ?? 0),
      pendingActions: Number(pendingActions?.value ?? 0),
      successRate,
      recentRuns: recentRuns.map(runView),
    }),
  );
});

router.get("/runs", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = ListRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const conditions = [eq(runsTable.organisationId, organisation.id)];
  if (parsed.data.status) conditions.push(eq(runsTable.status, parsed.data.status));
  const runs = await db
    .select()
    .from(runsTable)
    .where(and(...conditions))
    .orderBy(desc(runsTable.createdAt))
    .limit(parsed.data.limit);
  res.json(ListRunsResponse.parse(runs.map(runView)));
});

router.post(
  "/runs",
  requireRole("analyst", "administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const parsed = CreateRunBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const idempotencyKey = parsed.data.idempotencyKey ?? crypto.randomUUID();
    const run = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${organisation.id}:${idempotencyKey}`}))`);
      const [existing] = await tx
        .select()
        .from(runsTable)
        .where(and(
          eq(runsTable.organisationId, organisation.id),
          eq(runsTable.idempotencyKey, idempotencyKey),
        ))
        .limit(1);
      if (existing) return existing;
      const [created] = await tx.insert(runsTable).values({
        organisationId: organisation.id,
        createdByMemberId: member.id,
        fileName: parsed.data.fileName,
        fileType: parsed.data.fileType,
        fileSize: parsed.data.fileSize,
        objectPath: parsed.data.objectPath,
        idempotencyKey,
      }).returning();
      await tx.insert(auditEventsTable).values({
        organisationId: organisation.id,
        action: "upload.received",
        entityType: "run",
        entityId: created.id,
        actor: member.name,
        role: member.role,
        metadata: { fileName: created.fileName },
      });
      return created;
    });
    res.status(201).json(CreateRunResponse.parse(runView(run)));
  },
);

router.get("/runs/:runId", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = GetRunParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [run] = await db
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.id, parsed.data.runId),
      ),
    )
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const [rows, attempts] = await Promise.all([
    db
      .select()
      .from(importRowsTable)
      .where(and(
        run.importId
          ? eq(importRowsTable.importId, run.importId)
          : eq(importRowsTable.runId, run.id),
        eq(importRowsTable.organisationId, organisation.id),
      ))
      .orderBy(importRowsTable.rowNumber),
    db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.entityId, run.id),
          eq(auditEventsTable.organisationId, organisation.id),
          inArray(auditEventsTable.action, ["run.processed", "run.failed"]),
        ),
      )
      .orderBy(desc(auditEventsTable.createdAt)),
  ]);
  res.json(
    GetRunResponse.parse(buildRunDetail(runView(run), rows, attempts)),
  );
});

router.post(
  "/runs/:runId/process",
  requireRole("analyst", "administrator"),
  async (req, res): Promise<void> => {
  const { member, organisation } = getOperationsContext(req);
  const parsed = ProcessRunParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [run] = await db
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.id, parsed.data.runId),
        eq(runsTable.organisationId, organisation.id),
      ),
    )
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (run.status !== "queued" && run.status !== "failed") {
    res.status(409).json({ error: "Run cannot be processed in its current state" });
    return;
  }
  if (run.retryCount >= 3) {
    res.status(409).json({ error: "Run has reached the maximum attempt count" });
    return;
  }
  try {
    const processed = await processRunForOrganisation(
      run.id,
      organisation.id,
      member,
    );
    res.status(202).json(ProcessRunResponse.parse(runView(processed ?? run)));
  } catch (error) {
    if (error instanceof PipelineValidationError) {
      res.status(422).json({ error: error.message });
      return;
    }
    req.log.error({ err: error, runId: run.id }, "Import processing failed");
    res.status(503).json({ error: "Import processing failed and may be retried." });
  }
  },
);

router.get("/runs/:runId/exceptions", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = ListRunExceptionsParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const exceptions = await db
    .select()
    .from(validationExceptionsTable)
    .where(
      and(
        eq(validationExceptionsTable.runId, parsed.data.runId),
        eq(validationExceptionsTable.organisationId, organisation.id),
      ),
    )
    .orderBy(validationExceptionsTable.rowNumber);
  res.json(ListRunExceptionsResponse.parse(exceptions.map(exceptionView)));
});

function summaryView(
  summary: typeof evidenceSummariesTable.$inferSelect,
  sourceRowNumbers: number[],
) {
  const headlineSourceRows =
    summary.headlineSourceRows?.length > 0
      ? summary.headlineSourceRows
      : sourceRowNumbers;
  const overviewSourceRows =
    summary.overviewSourceRows?.length > 0
      ? summary.overviewSourceRows
      : sourceRowNumbers;
  return {
    id: summary.id,
    runId: summary.runId,
    headline: summary.headline,
    headlineSourceRows,
    overview: summary.overview,
    overviewSourceRows,
    riskLevel: summary.riskLevel,
    findings: summary.findings.map((finding) => ({
      ...finding,
      sourceRowNumbers:
        finding.sourceRowNumbers?.length > 0
          ? finding.sourceRowNumbers
          : sourceRowNumbers,
    })),
    generatedAt: summary.generatedAt,
    model: summary.model,
    promptVersion: summary.promptVersion,
  };
}

router.get("/runs/:runId/summary", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = GetRunSummaryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [summary] = await db
    .select()
    .from(evidenceSummariesTable)
    .where(
      and(
        eq(evidenceSummariesTable.runId, parsed.data.runId),
        eq(evidenceSummariesTable.organisationId, organisation.id),
      ),
    )
    .limit(1);
  if (!summary) {
    res.status(404).json({ error: "Summary not found" });
    return;
  }
  const sourceRows = await db
    .select({ rowNumber: importRowsTable.rowNumber })
    .from(importRowsTable)
    .where(
      and(
        eq(importRowsTable.runId, parsed.data.runId),
        eq(importRowsTable.organisationId, organisation.id),
      ),
    );
  res.json(
    GetRunSummaryResponse.parse(
      summaryView(summary, sourceRows.map((row) => row.rowNumber)),
    ),
  );
});

router.post(
  "/runs/:runId/summary",
  requireRole("analyst", "administrator"),
  async (req, res): Promise<void> => {
  const { member, organisation } = getOperationsContext(req);
  const params = GenerateRunSummaryParams.safeParse(req.params);
  const body = GenerateRunSummaryBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid summary request" });
    return;
  }
  const [run] = await db
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.id, params.data.runId),
        eq(runsTable.organisationId, organisation.id),
      ),
    )
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (run.status !== "succeeded" && run.status !== "partial") {
    res.status(409).json({ error: "Run is not ready for summarisation" });
    return;
  }
  const rows = await db
    .select({
      rowNumber: importRowsTable.rowNumber,
      accepted: importRowsTable.accepted,
      data: importRowsTable.data,
    })
    .from(importRowsTable)
    .where(
      and(
        eq(importRowsTable.runId, run.id),
        eq(importRowsTable.organisationId, organisation.id),
      ),
    )
    .orderBy(importRowsTable.rowNumber);
  if (rows.length === 0) {
    res.status(409).json({ error: "No ingested records are available for summarisation" });
    return;
  }
  const [existing] = await db
    .select()
    .from(evidenceSummariesTable)
    .where(eq(evidenceSummariesTable.runId, run.id))
    .limit(1);
  if (existing && !body.data.forceRegenerate) {
    res.status(201).json(
      GenerateRunSummaryResponse.parse(
        summaryView(existing, rows.map((row) => row.rowNumber)),
      ),
    );
    return;
  }

  const exceptions = await db
    .select()
    .from(validationExceptionsTable)
    .where(
      and(
        eq(validationExceptionsTable.runId, run.id),
        eq(validationExceptionsTable.organisationId, organisation.id),
      ),
    );
  await db
    .update(runsTable)
    .set({ summaryStatus: "generating", updatedAt: new Date() })
    .where(eq(runsTable.id, run.id));

  const sourceRowNumbers = new Set(rows.map((row) => row.rowNumber));
  try {
    const parsedSummary = await generateStructuredSummary(
      {
        records: rows.map((row) => ({
          rowNumber: row.rowNumber,
          accepted: row.accepted,
          data: row.data,
        })),
        exceptions: exceptions.map((exception) => ({
          rowNumber: exception.rowNumber,
          field: exception.field,
          code: exception.code,
          message: exception.message,
          severity: exception.severity,
          value: exception.value,
        })),
      },
      sourceRowNumbers,
      {
        complete: ((request, options) =>
          openai.chat.completions.create(request, options)) as SummaryCompletion,
        isRateLimited: isRateLimitError,
      },
    );
    const summary = await db.transaction(async (tx) => {
      const [stored] = await tx
        .insert(evidenceSummariesTable)
        .values({
          organisationId: organisation.id,
          runId: run.id,
          ...parsedSummary,
          model: SUMMARY_MODEL,
          promptVersion: SUMMARY_PROMPT_VERSION,
        })
        .onConflictDoUpdate({
          target: evidenceSummariesTable.runId,
          set: {
            ...parsedSummary,
            model: SUMMARY_MODEL,
            promptVersion: SUMMARY_PROMPT_VERSION,
            generatedAt: new Date(),
          },
        })
        .returning();
      await tx
        .update(runsTable)
        .set({ summaryStatus: "ready", updatedAt: new Date() })
        .where(eq(runsTable.id, run.id));
      await tx.insert(auditEventsTable).values({
        organisationId: organisation.id,
        action: "summary.generated",
        entityType: "summary",
        entityId: stored.id,
        actor: member.name,
        role: member.role,
        metadata: {
          runId: run.id,
          model: SUMMARY_MODEL,
          promptVersion: SUMMARY_PROMPT_VERSION,
        },
      });
      return stored;
    });
    res.status(201).json(
      GenerateRunSummaryResponse.parse(
        summaryView(summary, [...sourceRowNumbers]),
      ),
    );
  } catch (error) {
    const state =
      error instanceof SummaryGenerationError ? error.state : "failed";
    const attempts =
      error instanceof SummaryGenerationError ? error.attempts : 1;
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(runsTable)
          .set({
            summaryStatus: state,
            updatedAt: new Date(),
          })
          .where(eq(runsTable.id, run.id));
        await tx.insert(auditEventsTable).values({
          organisationId: organisation.id,
          action: "summary.generation_failed",
          entityType: "run",
          entityId: run.id,
          actor: member.name,
          role: member.role,
          metadata: {
            runId: run.id,
            model: SUMMARY_MODEL,
            promptVersion: SUMMARY_PROMPT_VERSION,
            failureState: state,
            attempts,
            retryable: state !== "failed",
          },
        });
      });
    } catch (auditError) {
      req.log.error(
        { err: auditError, runId: run.id },
        "Could not record evidence summary failure",
      );
    }
    req.log.error(
      { err: error, runId: run.id, failureState: state, attempts },
      "Evidence summary generation failed",
    );
    const responseStatus =
      state === "timeout"
        ? 504
        : state === "rate_limited"
          ? 429
          : state === "malformed_output"
            ? 422
            : 503;
    res.status(responseStatus).json({
      error:
        state === "timeout"
          ? "Evidence summary generation timed out and can be retried."
          : state === "rate_limited"
            ? "Evidence summary generation was rate limited and can be retried."
            : state === "malformed_output"
              ? "The model returned an invalid evidence summary and it can be retried."
              : "Evidence summary generation failed and may be retried.",
      code: state,
      retryable: state !== "failed",
    });
  }
  },
);

router.get("/actions", async (req, res): Promise<void> => {
  const { member, organisation } = getOperationsContext(req);
  const parsed = ListActionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const conditions = [eq(actionRequestsTable.organisationId, organisation.id)];
  if (parsed.data.status) {
    conditions.push(eq(actionRequestsTable.status, parsed.data.status));
  }
  const actions = await db
    .select()
    .from(actionRequestsTable)
    .where(and(...conditions))
    .orderBy(desc(actionRequestsTable.requestedAt));
  res.json(ListActionsResponse.parse(actions.map((action) => actionView(action, member))));
});

router.post(
  "/actions",
  requireRole("analyst", "administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const requestedActionType =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>).actionType
        : undefined;
    if (
      typeof requestedActionType === "string" &&
      !isAllowedActionType(requestedActionType)
    ) {
      res.status(400).json({ error: "Unsupported action type" });
      return;
    }
    const parsed = RequestActionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [ownedRun] = await db
      .select({ id: runsTable.id })
      .from(runsTable)
      .where(
        and(
          eq(runsTable.id, parsed.data.runId),
          eq(runsTable.organisationId, organisation.id),
        ),
      )
      .limit(1);
    if (!ownedRun) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const action = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(actionRequestsTable)
        .values({
          organisationId: organisation.id,
          runId: parsed.data.runId,
          actionType: parsed.data.actionType,
          title: parsed.data.title,
          rationale: parsed.data.rationale,
          requestedByMemberId: member.id,
        })
        .returning();
      await tx.insert(auditEventsTable).values({
        organisationId: organisation.id,
        action: "action.requested",
        entityType: "action",
        entityId: created.id,
        actor: member.name,
        role: member.role,
        metadata: { actionType: created.actionType, runId: created.runId },
      });
      return created;
    });
    res.status(201).json(RequestActionResponse.parse(actionView(action, member)));
  },
);

router.post(
  "/actions/:actionId/approve",
  requireRole("administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const params = ApproveActionParams.safeParse(req.params);
    const body = ApproveActionBody.safeParse(req.body);
    if (!params.success || !body.success || !body.data.reason.trim()) {
      res.status(400).json({ error: "A recorded approval reason is required" });
      return;
    }
    const reason = body.data.reason.trim();
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${params.data.actionId}))`,
      );
      const [action] = await tx
        .select()
        .from(actionRequestsTable)
        .where(
          and(
            eq(actionRequestsTable.id, params.data.actionId),
            eq(actionRequestsTable.organisationId, organisation.id),
          ),
        )
        .limit(1);
      if (!action) return { error: "not_found" as const };
      if (action.requestedByMemberId === member.id) {
        return { error: "self_approval" as const };
      }
      if (action.status !== "requested") {
        return { error: "already_decided" as const };
      }
      if (!isAllowedActionType(action.actionType)) {
        return { error: "unsupported_action" as const };
      }
      const decidedAt = new Date();
      const [approved] = await tx
        .update(actionRequestsTable)
        .set({
          status: "approved",
          decidedByMemberId: member.id,
          decidedAt,
          decisionNote: reason,
        })
        .where(
          and(
            eq(actionRequestsTable.id, action.id),
            eq(actionRequestsTable.status, "requested"),
          ),
        )
        .returning();
      if (!approved) return { error: "already_decided" as const };
      await tx.insert(approvalsTable).values({
        organisationId: organisation.id,
        actionRequestId: action.id,
        decidedByMemberId: member.id,
        decision: "approved",
        reason,
      });
      const [execution] = await tx
        .insert(actionExecutionsTable)
        .values({
          organisationId: organisation.id,
          actionRequestId: action.id,
          actionType: action.actionType,
          effect: actionEffect(action.actionType, action.runId),
        })
        .returning();
      const [completed] = await tx
        .update(actionRequestsTable)
        .set({
          status: "completed",
          decidedByMemberId: member.id,
          decidedAt,
          decisionNote: reason,
          result: actionResult(action.actionType),
        })
        .where(
          and(
            eq(actionRequestsTable.id, action.id),
            eq(actionRequestsTable.status, "approved"),
          ),
        )
        .returning();
      if (!completed) {
        throw new Error("Approved action could not be marked completed");
      }
      await tx.insert(auditEventsTable).values({
        organisationId: organisation.id,
        action: "action.approved",
        entityType: "action",
        entityId: action.id,
        actor: member.name,
        role: member.role,
        metadata: {
          runId: action.runId,
          actionType: action.actionType,
          reason,
          executed: true,
          executionId: execution.id,
          effect: execution.effect,
        },
      });
      return { completed };
    });
    if ("error" in outcome) {
      if (outcome.error === "not_found") {
        res.status(404).json({ error: "Action not found" });
      } else if (outcome.error === "self_approval") {
        res.status(403).json({ error: "You cannot approve your own action request" });
      } else if (outcome.error === "unsupported_action") {
        res.status(409).json({ error: "The requested action type is not supported" });
      } else {
        res.status(409).json({ error: "Action is no longer awaiting approval" });
      }
      return;
    }
    res.json(ApproveActionResponse.parse(actionView(outcome.completed, member)));
  },
);

router.post(
  "/actions/:actionId/reject",
  requireRole("administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const params = RejectActionParams.safeParse(req.params);
    const body = RejectActionBody.safeParse(req.body ?? {});
    if (!params.success || !body.success || !body.data.reason.trim()) {
      res.status(400).json({ error: "A recorded rejection reason is required" });
      return;
    }
    const reason = body.data.reason.trim();
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${params.data.actionId}))`,
      );
      const [action] = await tx
        .select()
        .from(actionRequestsTable)
        .where(
          and(
            eq(actionRequestsTable.id, params.data.actionId),
            eq(actionRequestsTable.organisationId, organisation.id),
          ),
        )
        .limit(1);
      if (!action) return { error: "not_found" as const };
      if (action.requestedByMemberId === member.id) {
        return { error: "self_decision" as const };
      }
      if (action.status !== "requested") {
        return { error: "already_decided" as const };
      }
      const [rejected] = await tx
        .update(actionRequestsTable)
        .set({
          status: "rejected",
          decidedByMemberId: member.id,
          decidedAt: new Date(),
          decisionNote: reason,
        })
        .where(
          and(
            eq(actionRequestsTable.id, action.id),
            eq(actionRequestsTable.status, "requested"),
          ),
        )
        .returning();
      if (!rejected) return { error: "already_decided" as const };
      await tx.insert(approvalsTable).values({
        organisationId: organisation.id,
        actionRequestId: action.id,
        decidedByMemberId: member.id,
        decision: "rejected",
        reason,
      });
      await tx.insert(auditEventsTable).values({
        organisationId: organisation.id,
        action: "action.rejected",
        entityType: "action",
        entityId: rejected.id,
        actor: member.name,
        role: member.role,
        metadata: { runId: action.runId, actionType: action.actionType, reason },
      });
      return { rejected };
    });
    if ("error" in outcome) {
      if (outcome.error === "not_found") {
        res.status(404).json({ error: "Action not found" });
      } else if (outcome.error === "self_decision") {
        res.status(403).json({ error: "You cannot decide your own action request" });
      } else {
        res.status(409).json({ error: "Action is no longer awaiting approval" });
      }
      return;
    }
    res.json(RejectActionResponse.parse(actionView(outcome.rejected, member)));
  },
);

router.get("/audit", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = ListAuditEventsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [events, refusals] = await Promise.all([
    db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organisationId, organisation.id))
      .orderBy(desc(auditEventsTable.createdAt))
      .limit(parsed.data.limit),
    db
      .select()
      .from(inboundRefusalAuditTable)
      .where(eq(inboundRefusalAuditTable.verifiedOrganisationId, organisation.id))
      .orderBy(desc(inboundRefusalAuditTable.createdAt))
      .limit(parsed.data.limit),
  ]);
  const auditEntries = [
    ...events.map((event) => ({
      id: event.id,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      actor: event.actor,
      role: event.role,
      createdAt: event.createdAt,
      metadata: event.metadata ?? {},
    })),
    ...refusals.map((refusal) => ({
      id: refusal.id,
      action: "inbound.refused",
      entityType: "inbound_delivery",
      entityId: refusal.externalId ?? refusal.deliveryId ?? "unknown",
      actor: "Inbound webhook gateway",
      role: "administrator" as const,
      createdAt: refusal.createdAt,
      metadata: {
        reason: refusal.reason,
        source: refusal.source,
        externalId: refusal.externalId,
        deliveryId: refusal.deliveryId,
        status: refusal.statusCode,
      },
    })),
  ]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, parsed.data.limit);
  res.json(
    ListAuditEventsResponse.parse(
      auditEntries,
    ),
  );
});

router.get("/settings", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  res.json(
    GetSettingsResponse.parse({
      id: organisation.id,
      name: organisation.name,
      code: organisation.code,
      retentionDays: organisation.retentionDays,
      requireApproval: organisation.requireApproval,
    }),
  );
});

router.patch(
  "/settings",
  requireRole("administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const updated = await db.transaction(async (tx) => {
      const [stored] = await tx
        .update(organisationsTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(organisationsTable.id, organisation.id))
        .returning();
      await tx.insert(auditEventsTable).values({
        organisationId: organisation.id,
        action: "settings.updated",
        entityType: "organisation",
        entityId: organisation.id,
        actor: member.name,
        role: member.role,
        metadata: parsed.data,
      });
      return stored;
    });
    res.json(
      UpdateSettingsResponse.parse({
        id: updated.id,
        name: updated.name,
        code: updated.code,
        retentionDays: updated.retentionDays,
        requireApproval: updated.requireApproval,
      }),
    );
  },
);

export default router;