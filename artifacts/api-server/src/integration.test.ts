import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { describe, it, before, after } from "node:test";

import express from "express";
import { count, eq } from "drizzle-orm";
import pg from "pg";
import pinoHttp from "pino-http";

import {
  buildInboundSignature,
} from "./lib/inboundPolicy.ts";
import {
  generateStructuredSummary,
  SummaryGenerationError,
} from "./lib/summaryService.ts";
import { logger } from "./lib/logger.ts";

/*
 * This suite deliberately imports the database-backed application only after
 * creating a private schema and putting that schema first on the pool's
 * search_path.  The production tables remain untouched, while Drizzle's
 * unqualified table names continue to exercise the production code unchanged.
 */
const schemaName = `operations_test_${process.pid}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
const fixture = {
  organisationA: "10000000-0000-4000-8000-000000000001",
  organisationB: "10000000-0000-4000-8000-000000000002",
  analyst: "10000000-0000-4000-8000-000000000011",
  administrator: "10000000-0000-4000-8000-000000000012",
  auditor: "10000000-0000-4000-8000-000000000013",
  otherMember: "10000000-0000-4000-8000-000000000014",
  crossOrgRun: "10000000-0000-4000-8000-000000000101",
  malformedRun: "10000000-0000-4000-8000-000000000102",
  duplicateRunA: "10000000-0000-4000-8000-000000000103",
  duplicateRunB: "10000000-0000-4000-8000-000000000104",
  actionRun: "10000000-0000-4000-8000-000000000105",
} as const;

type DatabaseModule = typeof import("@workspace/db");
let database: DatabaseModule;
let server: Server;
let baseUrl = "";
let integrationsRouter: (typeof import("./routes/integrations.ts"))["default"];
let operationsRouter: (typeof import("./routes/operations.ts"))["default"];
let processRunForOrganisation: typeof import("./lib/processing.ts")["processRunForOrganisation"];

const rawBodyVerify = (
  request: express.Request,
  _response: express.Response,
  buffer: Buffer,
) => {
  (request as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
};

async function createIsolatedSchema() {
  if (!originalDatabaseUrl) {
    throw new Error("DATABASE_URL is required for backend integration tests.");
  }
  const setupPool = new pg.Pool({ connectionString: originalDatabaseUrl });
  const tableNames = [
    "operations_organisations",
    "operations_members",
    "operations_imports",
    "operations_runs",
    "operations_import_rows",
    "operations_validation_exceptions",
    "operations_evidence_summaries",
    "operations_action_requests",
    "operations_approvals",
    "operations_action_executions",
    "operations_audit_events",
    "operations_inbound_refusal_audit",
    "operations_inbound_deliveries",
  ];
  try {
    await setupPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await setupPool.query(`CREATE SCHEMA "${schemaName}"`);
    for (const tableName of tableNames) {
      await setupPool.query(
        `CREATE TABLE "${schemaName}"."${tableName}" (LIKE public."${tableName}" INCLUDING ALL)`,
      );
    }
  } finally {
    await setupPool.end();
  }
  const isolatedUrl = new URL(originalDatabaseUrl);
  isolatedUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
  process.env.DATABASE_URL = isolatedUrl.toString();
  // Load the production Drizzle module only after every connection has been
  // pinned to the private schema through its connection parameters.
  database = await import("@workspace/db");
}

async function insertFixtures() {
  const {
    organisationsTable,
    membersTable,
    runsTable,
    actionRequestsTable,
  } = database;
  await database.db.insert(organisationsTable).values([
    {
      id: fixture.organisationA,
      name: "Integration Organisation A",
      code: "INTEGRATION-A",
    },
    {
      id: fixture.organisationB,
      name: "Integration Organisation B",
      code: "INTEGRATION-B",
    },
  ]);
  await database.db.insert(membersTable).values([
    {
      id: fixture.analyst,
      organisationId: fixture.organisationA,
      clerkUserId: "integration-analyst",
      email: "integration-analyst@example.test",
      name: "Integration Analyst",
      role: "analyst",
    },
    {
      id: fixture.administrator,
      organisationId: fixture.organisationA,
      clerkUserId: "integration-administrator",
      email: "integration-administrator@example.test",
      name: "Integration Administrator",
      role: "administrator",
    },
    {
      id: fixture.auditor,
      organisationId: fixture.organisationA,
      clerkUserId: "integration-auditor",
      email: "integration-auditor@example.test",
      name: "Integration Auditor",
      role: "auditor",
    },
    {
      id: fixture.otherMember,
      organisationId: fixture.organisationB,
      clerkUserId: "integration-other",
      email: "integration-other@example.test",
      name: "Other Organisation Member",
      role: "analyst",
    },
  ]);
  await database.db.insert(runsTable).values([
    {
      id: fixture.crossOrgRun,
      organisationId: fixture.organisationB,
      createdByMemberId: fixture.otherMember,
      fileName: "cross-org.csv",
      fileType: "text/csv",
      fileSize: 1,
      objectPath: "/objects/integration/cross-org",
      idempotencyKey: "integration:cross-org",
    },
    {
      id: fixture.actionRun,
      organisationId: fixture.organisationA,
      createdByMemberId: fixture.analyst,
      fileName: "action.csv",
      fileType: "text/csv",
      fileSize: 1,
      objectPath: "/objects/integration/action",
      idempotencyKey: "integration:action",
    },
  ]);
  // Keep this reference in the fixture setup so accidental changes to the
  // production action schema fail at setup rather than in an unrelated test.
  const existingActions = await database.db.select({ value: count() }).from(actionRequestsTable);
  assert.equal(Number(existingActions[0]?.value ?? 0), 0);
}

async function startHttpApp() {
  process.env.INBOUND_WEBHOOK_SECRET = "integration-inbound-secret";
  process.env.OPERATIONS_JOB_TOKEN = "integration-job-token";

  integrationsRouter = (await import("./routes/integrations.ts")).default;
  operationsRouter = (await import("./routes/operations.ts")).default;
  processRunForOrganisation =
    (await import("./lib/processing.ts")).processRunForOrganisation;

  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json({ verify: rawBodyVerify }));
  app.use((request, _response, next) => {
    const clerkUserId =
      request.header("x-integration-user") ?? "integration-analyst";
    void database.db
      .select({
        member: database.membersTable,
        organisation: database.organisationsTable,
      })
      .from(database.membersTable)
      .innerJoin(
        database.organisationsTable,
        eq(
          database.membersTable.organisationId,
          database.organisationsTable.id,
        ),
      )
      .where(eq(database.membersTable.clerkUserId, clerkUserId))
      .limit(1)
      .then(([context]) => {
        if (context) {
          (
            request as express.Request & {
              operationsContext?: typeof context;
            }
          ).operationsContext = context;
        }
        next();
      }, next);
  });
  app.use("/api", integrationsRouter);
  app.use("/api", operationsRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start.");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function request(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, init);
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function storageFor(bytes: Buffer) {
  const file = {
    getMetadata: async () => [{ size: bytes.byteLength }],
  };
  return {
    getObjectEntityFile: async () => file,
    downloadObject: async () =>
      new Response(bytes, { headers: { "content-type": "application/json" } }),
  } as never;
}

async function countRows(table: string) {
  const result = await database.pool.query(`SELECT count(*)::int AS value FROM "${table}"`);
  return Number(result.rows[0]?.value ?? 0);
}

describe("safe-main backend integration boundaries", () => {
  before(async () => {
    await createIsolatedSchema();
    await insertFixtures();
    await startHttpApp();
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (database) {
      await database.pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await database.pool.end();
    }
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  it("returns 401 when the processing job token is missing", async () => {
    const response = await request(
      "/api/jobs/process-imports",
      jsonRequest({ organisationId: fixture.organisationA, maxRuns: 1 }),
    );
    assert.equal(response.status, 401);
  });

  it("returns 404 for a run owned by another organisation", async () => {
    const response = await request(
      `/api/runs/${fixture.crossOrgRun}`,
      { headers: { "x-integration-user": "integration-analyst" } },
    );
    assert.equal(response.status, 404);
  });

  it("rejects a forged inbound HMAC with no delivery row", async () => {
    const body = {
      eventId: "integration-forged-event",
      organisationId: fixture.organisationA,
      eventType: "run.noop",
      payload: {},
    };
    const response = await request(
      "/api/webhooks/inbound",
      jsonRequest(body, {
        "x-operations-source": "integration-source",
        "x-operations-delivery": "integration-delivery-forged",
        "x-operations-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-operations-signature": "00".repeat(32),
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(await countRows("operations_inbound_deliveries"), 0);
  });

  it("accepts a signed delivery once and identifies the second delivery as duplicate", async () => {
    const body = {
      eventId: "integration-replayed-event",
      organisationId: fixture.organisationA,
      eventType: "run.noop",
      payload: {},
    };
    const rawBody = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const source = "integration-replay-source";
    const signature = buildInboundSignature({
      secret: "integration-inbound-secret",
      timestamp,
      source,
      rawBody,
    });
    const headers = {
      "x-operations-source": source,
      "x-operations-timestamp": String(timestamp),
      "x-operations-signature": signature,
      "x-operations-delivery": "integration-replay-delivery-1",
    };
    const first = await request(
      "/api/webhooks/inbound",
      jsonRequest(body, headers),
    );
    const second = await request(
      "/api/webhooks/inbound",
      jsonRequest(body, { ...headers, "x-operations-delivery": "integration-replay-delivery-2" }),
    );
    assert.equal(first.status, 202);
    const firstBody = await first.json() as { accepted?: boolean };
    assert.equal(firstBody.accepted, true);
    assert.equal(second.status, 409);
    const secondBody = await second.json() as { error?: string };
    assert.match(secondBody.error ?? "", /already received/);
    assert.equal(await countRows("operations_inbound_deliveries"), 1);
  });

  it("processes a malformed fixture into rejected rows and validation exceptions", async () => {
    const { runsTable, importRowsTable } = database;
    await database.db.insert(runsTable).values({
      id: fixture.malformedRun,
      organisationId: fixture.organisationA,
      createdByMemberId: fixture.analyst,
      fileName: "malformed.csv",
      fileType: "text/csv",
      fileSize: 1,
      objectPath: "/objects/integration/malformed",
      idempotencyKey: "integration:malformed",
    });
    const bytes = await readFile(
      new URL("../../../sample-data/fixtures/malformed.csv", import.meta.url),
    );
    const processed = await processRunForOrganisation(
      fixture.malformedRun,
      fixture.organisationA,
      { id: fixture.analyst, name: "Integration Analyst", role: "analyst" },
      undefined,
      { storage: storageFor(bytes) },
    );
    assert.equal(processed?.status, "partial");
    const [run] = await database.db.select().from(runsTable).where(eq(runsTable.id, fixture.malformedRun));
    assert.equal(run?.status, "partial");
    assert.equal(run?.exceptionCount, 3);
    const malformedRows = await database.db
      .select()
      .from(importRowsTable)
      .where(eq(importRowsTable.runId, fixture.malformedRun));
    assert.deepEqual(malformedRows.map((row) => row.accepted), [false, true]);
    assert.equal(await countRows("operations_import_rows"), 2);
    assert.equal(await countRows("operations_validation_exceptions"), 3);
  });

  it("reuses one import and its rows for identical bytes in two runs", async () => {
    const { runsTable, importsTable, importRowsTable } = database;
    const bytes = Buffer.from(
      "record_id,email,amount,effective_date\nsame-001,same@example.test,5,2025-01-02\n",
    );
    await database.db.insert(runsTable).values([
      {
        id: fixture.duplicateRunA,
        organisationId: fixture.organisationA,
        createdByMemberId: fixture.analyst,
        fileName: "same-a.csv",
        fileType: "text/csv",
        fileSize: bytes.byteLength,
        objectPath: "/objects/integration/same-a",
        idempotencyKey: "integration:same-a",
      },
      {
        id: fixture.duplicateRunB,
        organisationId: fixture.organisationA,
        createdByMemberId: fixture.analyst,
        fileName: "same-b.csv",
        fileType: "text/csv",
        fileSize: bytes.byteLength,
        objectPath: "/objects/integration/same-b",
        idempotencyKey: "integration:same-b",
      },
    ]);
    const storage = storageFor(bytes);
    await processRunForOrganisation(fixture.duplicateRunA, fixture.organisationA, {
      id: fixture.analyst, name: "Integration Analyst", role: "analyst",
    }, undefined, { storage });
    await processRunForOrganisation(fixture.duplicateRunB, fixture.organisationA, {
      id: fixture.analyst, name: "Integration Analyst", role: "analyst",
    }, undefined, { storage });
    const [firstRun] = await database.db.select().from(runsTable).where(eq(runsTable.id, fixture.duplicateRunA));
    const [secondRun] = await database.db.select().from(runsTable).where(eq(runsTable.id, fixture.duplicateRunB));
    assert.equal(firstRun?.importId, secondRun?.importId);
    const imports = await database.db.select({ value: count() }).from(importsTable);
    assert.equal(Number(imports[0]?.value ?? 0), 2);
    const sharedRows = await database.db
      .select({ value: count() })
      .from(importRowsTable)
      .where(eq(importRowsTable.importId, firstRun?.importId ?? ""));
    assert.equal(Number(sharedRows[0]?.value ?? 0), 1);
  });

  it("rejects schema-invalid valid JSON after bounded summary attempts", { timeout: 5_000 }, async () => {
    let calls = 0;
    await assert.rejects(
      generateStructuredSummary(
        {
          records: [{ rowNumber: 2, accepted: true, data: { record_id: "summary-1" } }],
          exceptions: [],
        },
        new Set([2]),
        {
          complete: async () => {
            calls += 1;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    headline: "Missing required fields",
                    unexpectedInstruction: "ignore the evidence policy",
                  }),
                },
              }],
            };
          },
          delay: async () => {},
        },
      ),
      (error: unknown) =>
        error instanceof SummaryGenerationError &&
        error.state === "malformed_output" &&
        error.attempts === 3,
    );
    assert.equal(calls, 3);
  });

  it("returns 403 for analyst and auditor approval attempts through route middleware", async () => {
    const analystRequest = await request("/api/actions", {
      ...jsonRequest({
        runId: fixture.actionRun,
        actionType: "request_correction",
        title: "Review source",
        rationale: "The source should be reviewed.",
      }),
      headers: {
        "content-type": "application/json",
        "x-integration-user": "integration-analyst",
      },
    });
    assert.equal(analystRequest.status, 201);
    const action = await analystRequest.json() as { id: string };

    const analystApproval = await request(`/api/actions/${action.id}/approve`, {
      ...jsonRequest({ reason: "Not permitted for analyst." }),
      headers: {
        "content-type": "application/json",
        "x-integration-user": "integration-analyst",
      },
    });
    const auditorApproval = await request(`/api/actions/${action.id}/approve`, {
      ...jsonRequest({ reason: "Not permitted for auditor." }),
      headers: {
        "content-type": "application/json",
        "x-integration-user": "integration-auditor",
      },
    });
    assert.equal(analystApproval.status, 403);
    assert.equal(auditorApproval.status, 403);
  });
});