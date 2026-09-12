import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { createClerkClient } from "@clerk/backend";
import { eq, sql } from "drizzle-orm";
import {
  actionExecutionsTable,
  actionRequestsTable,
  approvalsTable,
  auditEventsTable,
  db,
  evidenceSummariesTable,
  importRowsTable,
  importsTable,
  inboundDeliveriesTable,
  inboundRefusalAuditTable,
  membersTable,
  organisationsTable,
  pool,
  runsTable,
  validationExceptionsTable,
} from "@workspace/db";

const organisationCode = "NORTHSTAR-OPS";
const organisationId = "00000000-0000-4000-8000-000000000001";
const seededAt = new Date("2025-01-15T12:00:00.000Z");
const fixturesDirectory = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../sample-data/fixtures",
);

const demoUsers = [
  {
    id: "00000000-0000-4000-8000-000000000011",
    email: "analyst@proofops.dev",
    firstName: "Avery",
    lastName: "Analyst",
    role: "analyst" as const,
  },
  {
    id: "00000000-0000-4000-8000-000000000012",
    email: "administrator@proofops.dev",
    firstName: "Morgan",
    lastName: "Administrator",
    role: "administrator" as const,
  },
  {
    id: "00000000-0000-4000-8000-000000000013",
    email: "auditor@proofops.dev",
    firstName: "Riley",
    lastName: "Auditor",
    role: "auditor" as const,
  },
];

const seededRuns = {
  clean: "00000000-0000-4000-8000-000000000101",
  malformed: "00000000-0000-4000-8000-000000000102",
  duplicate: "00000000-0000-4000-8000-000000000103",
} as const;

const seededImports = {
  clean: "00000000-0000-4000-8000-000000000201",
  malformed: "00000000-0000-4000-8000-000000000202",
} as const;

const seededRows = {
  cleanOne: "00000000-0000-4000-8000-000000000301",
  cleanTwo: "00000000-0000-4000-8000-000000000302",
  malformedOne: "00000000-0000-4000-8000-000000000303",
  malformedTwo: "00000000-0000-4000-8000-000000000304",
} as const;

const seededExceptions = {
  malformedEmail: "00000000-0000-4000-8000-000000000401",
  malformedAmount: "00000000-0000-4000-8000-000000000402",
  malformedDate: "00000000-0000-4000-8000-000000000403",
} as const;

const seededAuditEvents = {
  clean: "00000000-0000-4000-8000-000000000501",
  malformed: "00000000-0000-4000-8000-000000000502",
  duplicate: "00000000-0000-4000-8000-000000000503",
} as const;

async function ensureClerkUser(
  clerk: ReturnType<typeof createClerkClient>,
  user: (typeof demoUsers)[number],
) {
  const existing = await clerk.users.getUserList({
    emailAddress: [user.email],
    limit: 1,
  });
  if (existing.data[0]) return existing.data[0];

  const password = process.env.DEMO_USER_PASSWORD;
  if (!password) {
    throw new Error(
      "DEMO_USER_PASSWORD is required to create demo Clerk accounts.",
    );
  }
  return clerk.users.createUser({
    emailAddress: [user.email],
    password,
    firstName: user.firstName,
    lastName: user.lastName,
  });
}

async function readFixture(fileName: string) {
  const content = await readFile(resolve(fixturesDirectory, fileName));
  return {
    content,
    fileName,
    fileSize: content.byteLength,
    contentHash: createHash("sha256").update(content).digest("hex"),
    objectPath: `sample-data/fixtures/${fileName}`,
  };
}

async function ensureOrganisationAndMembers() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "CLERK_SECRET_KEY is required so the seed can create sign-in accounts.",
    );
  }
  const clerk = createClerkClient({ secretKey });
  const [organisation] = await db
    .insert(organisationsTable)
    .values({
      id: organisationId,
      name: "Northstar Operations",
      code: organisationCode,
      retentionDays: 365,
      requireApproval: true,
      createdAt: seededAt,
      updatedAt: seededAt,
    })
    .onConflictDoUpdate({
      target: organisationsTable.code,
      set: {
        name: "Northstar Operations",
        retentionDays: 365,
        requireApproval: true,
        updatedAt: seededAt,
      },
    })
    .returning();

  for (const user of demoUsers) {
    const clerkUser = await ensureClerkUser(clerk, user);
    await db
      .insert(membersTable)
      .values({
        id: user.id,
        organisationId: organisation.id,
        clerkUserId: clerkUser.id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        role: user.role,
        createdAt: seededAt,
      })
      .onConflictDoUpdate({
        target: membersTable.clerkUserId,
        set: {
          organisationId: organisation.id,
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
        },
      });
  }

  const members = await db
    .select()
    .from(membersTable)
    .where(eq(membersTable.organisationId, organisation.id));
  const analyst = members.find((member) => member.role === "analyst");
  if (!analyst) throw new Error("The seeded analyst member could not be created.");
  return { organisation, analyst };
}

async function seed() {
  const { organisation, analyst } = await ensureOrganisationAndMembers();
  const [clean, malformed, duplicate] = await Promise.all([
    readFixture("clean.csv"),
    readFixture("malformed.csv"),
    readFixture("duplicate.csv"),
  ]);

  // duplicate.csv intentionally has the same bytes as clean.csv. It is a
  // second run of the same content and therefore reuses the clean import.
  await db
    .insert(importsTable)
    .values([
      {
        id: seededImports.clean,
        organisationId: organisation.id,
        uploadedByMemberId: analyst.id,
        fileName: clean.fileName,
        contentType: "text/csv",
        fileSize: clean.fileSize,
        objectPath: clean.objectPath,
        contentHash: clean.contentHash,
        createdAt: seededAt,
      },
      {
        id: seededImports.malformed,
        organisationId: organisation.id,
        uploadedByMemberId: analyst.id,
        fileName: malformed.fileName,
        contentType: "text/csv",
        fileSize: malformed.fileSize,
        objectPath: malformed.objectPath,
        contentHash: malformed.contentHash,
        createdAt: seededAt,
      },
    ])
    .onConflictDoUpdate({
      target: importsTable.id,
      set: {
        organisationId: organisation.id,
        uploadedByMemberId: analyst.id,
        fileName: sql`excluded.file_name`,
        contentType: sql`excluded.content_type`,
        fileSize: sql`excluded.file_size`,
        objectPath: sql`excluded.object_path`,
        contentHash: sql`excluded.content_hash`,
      },
    });

  await db
    .insert(runsTable)
    .values([
      {
        id: seededRuns.clean,
        organisationId: organisation.id,
        createdByMemberId: analyst.id,
        importId: seededImports.clean,
        fileName: clean.fileName,
        fileType: "text/csv",
        fileSize: clean.fileSize,
        objectPath: clean.objectPath,
        status: "succeeded",
        recordCount: 2,
        exceptionCount: 0,
        retryCount: 1,
        summaryStatus: "not_started",
        idempotencyKey: "seed:clean",
        createdAt: seededAt,
        startedAt: seededAt,
        completedAt: seededAt,
        updatedAt: seededAt,
      },
      {
        id: seededRuns.malformed,
        organisationId: organisation.id,
        createdByMemberId: analyst.id,
        importId: seededImports.malformed,
        fileName: malformed.fileName,
        fileType: "text/csv",
        fileSize: malformed.fileSize,
        objectPath: malformed.objectPath,
        status: "partial",
        recordCount: 2,
        exceptionCount: 3,
        retryCount: 1,
        summaryStatus: "not_started",
        idempotencyKey: "seed:malformed",
        createdAt: seededAt,
        startedAt: seededAt,
        completedAt: seededAt,
        updatedAt: seededAt,
      },
      {
        id: seededRuns.duplicate,
        organisationId: organisation.id,
        createdByMemberId: analyst.id,
        importId: seededImports.clean,
        fileName: duplicate.fileName,
        fileType: "text/csv",
        fileSize: duplicate.fileSize,
        objectPath: duplicate.objectPath,
        status: "succeeded",
        recordCount: 2,
        exceptionCount: 0,
        retryCount: 1,
        summaryStatus: "not_started",
        idempotencyKey: "seed:duplicate",
        createdAt: new Date("2025-01-15T12:01:00.000Z"),
        startedAt: new Date("2025-01-15T12:01:00.000Z"),
        completedAt: new Date("2025-01-15T12:01:00.000Z"),
        updatedAt: new Date("2025-01-15T12:01:00.000Z"),
      },
    ])
    .onConflictDoUpdate({
      target: runsTable.id,
      set: {
        organisationId: organisation.id,
        createdByMemberId: analyst.id,
        importId: sql`excluded.import_id`,
        fileName: sql`excluded.file_name`,
        fileType: sql`excluded.file_type`,
        fileSize: sql`excluded.file_size`,
        objectPath: sql`excluded.object_path`,
        status: sql`excluded.status`,
        recordCount: sql`excluded.record_count`,
        exceptionCount: sql`excluded.exception_count`,
        retryCount: sql`excluded.retry_count`,
        summaryStatus: sql`excluded.summary_status`,
        idempotencyKey: sql`excluded.idempotency_key`,
        createdAt: sql`excluded.created_at`,
        startedAt: sql`excluded.started_at`,
        completedAt: sql`excluded.completed_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  await db
    .insert(importRowsTable)
    .values([
      {
        id: seededRows.cleanOne,
        organisationId: organisation.id,
        importId: seededImports.clean,
        runId: seededRuns.clean,
        rowNumber: 2,
        accepted: true,
        data: {
          record_id: "clean-001",
          email: "owner.one@example.com",
          amount: "1250.00",
          effective_date: "2025-01-01",
        },
        createdAt: seededAt,
      },
      {
        id: seededRows.cleanTwo,
        organisationId: organisation.id,
        importId: seededImports.clean,
        runId: seededRuns.clean,
        rowNumber: 3,
        accepted: true,
        data: {
          record_id: "clean-002",
          email: "owner.two@example.com",
          amount: "875.50",
          effective_date: "2025-01-02",
        },
        createdAt: seededAt,
      },
      {
        id: seededRows.malformedOne,
        organisationId: organisation.id,
        importId: seededImports.malformed,
        runId: seededRuns.malformed,
        rowNumber: 2,
        accepted: false,
        data: {
          record_id: "malformed-001",
          email: "not-an-email",
          amount: "-25",
          effective_date: "2025-02-30",
        },
        createdAt: seededAt,
      },
      {
        id: seededRows.malformedTwo,
        organisationId: organisation.id,
        importId: seededImports.malformed,
        runId: seededRuns.malformed,
        rowNumber: 3,
        accepted: true,
        data: {
          record_id: "malformed-002",
          email: "valid@example.com",
          amount: "42.00",
          effective_date: "2025-01-03",
        },
        createdAt: seededAt,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(validationExceptionsTable)
    .values([
      {
        id: seededExceptions.malformedEmail,
        organisationId: organisation.id,
        runId: seededRuns.malformed,
        rowId: seededRows.malformedOne,
        rowNumber: 2,
        field: "email",
        code: "invalid_format",
        message: "Email must be a valid address.",
        severity: "medium",
        status: "open",
        value: "not-an-email",
        createdAt: seededAt,
      },
      {
        id: seededExceptions.malformedAmount,
        organisationId: organisation.id,
        runId: seededRuns.malformed,
        rowId: seededRows.malformedOne,
        rowNumber: 2,
        field: "amount",
        code: "too_small",
        message: "Amount must be a positive number.",
        severity: "high",
        status: "open",
        value: "-25",
        createdAt: seededAt,
      },
      {
        id: seededExceptions.malformedDate,
        organisationId: organisation.id,
        runId: seededRuns.malformed,
        rowId: seededRows.malformedOne,
        rowNumber: 2,
        field: "effective_date",
        code: "invalid_format",
        message: "Effective date must be a valid calendar date using YYYY-MM-DD.",
        severity: "low",
        status: "open",
        value: "2025-02-30",
        createdAt: seededAt,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(auditEventsTable)
    .values([
      {
        id: seededAuditEvents.clean,
        organisationId: organisation.id,
        action: "run.processed",
        entityType: "run",
        entityId: seededRuns.clean,
        actor: "Avery Analyst",
        role: "analyst",
        authSessionKey: "seed:clean",
        metadata: { recordCount: 2, exceptionCount: 0, status: "succeeded" },
        createdAt: seededAt,
      },
      {
        id: seededAuditEvents.malformed,
        organisationId: organisation.id,
        action: "run.processed",
        entityType: "run",
        entityId: seededRuns.malformed,
        actor: "Avery Analyst",
        role: "analyst",
        authSessionKey: "seed:malformed",
        metadata: { recordCount: 2, exceptionCount: 3, status: "partial" },
        createdAt: seededAt,
      },
      {
        id: seededAuditEvents.duplicate,
        organisationId: organisation.id,
        action: "run.processed",
        entityType: "run",
        entityId: seededRuns.duplicate,
        actor: "Avery Analyst",
        role: "analyst",
        authSessionKey: "seed:duplicate",
        metadata: {
          recordCount: 2,
          exceptionCount: 0,
          status: "succeeded",
          reusedImport: true,
        },
        createdAt: new Date("2025-01-15T12:01:00.000Z"),
      },
    ])
    .onConflictDoNothing();

  console.log(
    `Seeded ${organisation.name}: ${clean.fileName}, ${malformed.fileName}, and ${duplicate.fileName}.`,
  );
}

async function resetOperationsTables() {
  await db.transaction(async (tx) => {
    // The two audit ledgers are append-only in the running application. Reset
    // is an explicit local-data operation, so temporarily remove only those
    // guards inside this transaction, then put them back before committing.
    await tx.execute(sql.raw(`
      DROP TRIGGER IF EXISTS operations_audit_events_append_only
        ON operations_audit_events;
      DROP TRIGGER IF EXISTS operations_audit_events_no_truncate
        ON operations_audit_events;
      DROP TRIGGER IF EXISTS operations_inbound_refusal_audit_append_only
        ON operations_inbound_refusal_audit;
      DROP TRIGGER IF EXISTS operations_inbound_refusal_audit_no_truncate
        ON operations_inbound_refusal_audit;
      DELETE FROM operations_action_executions;
      DELETE FROM operations_approvals;
      DELETE FROM operations_action_requests;
      DELETE FROM operations_evidence_summaries;
      DELETE FROM operations_validation_exceptions;
      DELETE FROM operations_import_rows;
      DELETE FROM operations_audit_events;
      DELETE FROM operations_inbound_deliveries;
      DELETE FROM operations_inbound_refusal_audit;
      DELETE FROM operations_runs;
      DELETE FROM operations_imports;
      DELETE FROM operations_members;
      DELETE FROM operations_organisations;
      CREATE OR REPLACE FUNCTION operations_reject_audit_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'operations audit ledgers are append-only';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER operations_audit_events_append_only
        BEFORE UPDATE OR DELETE ON operations_audit_events
        FOR EACH ROW EXECUTE FUNCTION operations_reject_audit_mutation();
      CREATE TRIGGER operations_audit_events_no_truncate
        BEFORE TRUNCATE ON operations_audit_events
        FOR EACH STATEMENT EXECUTE FUNCTION operations_reject_audit_mutation();
      CREATE TRIGGER operations_inbound_refusal_audit_append_only
        BEFORE UPDATE OR DELETE ON operations_inbound_refusal_audit
        FOR EACH ROW EXECUTE FUNCTION operations_reject_audit_mutation();
      CREATE TRIGGER operations_inbound_refusal_audit_no_truncate
        BEFORE TRUNCATE ON operations_inbound_refusal_audit
        FOR EACH STATEMENT EXECUTE FUNCTION operations_reject_audit_mutation();
    `));
  });
  console.log("Reset Operations Evidence Console tables.");
}

async function main() {
  const command = process.argv[2] ?? "seed";
  if (command === "reset") {
    await resetOperationsTables();
    await seed();
    return;
  }
  if (command !== "seed") {
    throw new Error(`Unknown command "${command}". Use "seed" or "reset".`);
  }
  await seed();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });