import { and, eq, inArray, lt, sql } from "drizzle-orm";

import {
  actionRequestsTable,
  auditEventsTable,
  db,
  runsTable,
  validationExceptionsTable,
  type Member,
} from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";

const storage = new ObjectStorageService();
const MAX_RETRIES = 3;

type ProcessingActor = Pick<Member, "id" | "name" | "role">;

function splitCsvRow(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }

  values.push(value.trim());
  return values;
}

function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCsvRow(lines[0] ?? "").map((header) =>
    header.toLowerCase(),
  );
  return lines.slice(1).map((line) => {
    const values = splitCsvRow(line);
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    );
  });
}

function buildExceptions(
  runId: string,
  organisationId: string,
  rows: Array<Record<string, string>>,
) {
  const exceptions: Array<typeof validationExceptionsTable.$inferInsert> = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (!row.record_id) {
      exceptions.push({
        organisationId,
        runId,
        rowNumber,
        field: "record_id",
        code: "required",
        message: "Record ID is required.",
        severity: "high",
        status: "open",
        value: null,
      });
    }
    if (!row.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) {
      exceptions.push({
        organisationId,
        runId,
        rowNumber,
        field: "email",
        code: "invalid_email",
        message: "Email must be a valid address.",
        severity: "medium",
        status: "open",
        value: row.email || null,
      });
    }
    if (!row.amount || Number.isNaN(Number(row.amount)) || Number(row.amount) <= 0) {
      exceptions.push({
        organisationId,
        runId,
        rowNumber,
        field: "amount",
        code: "invalid_amount",
        message: "Amount must be a positive number.",
        severity: "high",
        status: "open",
        value: row.amount || null,
      });
    }
    if (
      !row.effective_date ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.effective_date)
    ) {
      exceptions.push({
        organisationId,
        runId,
        rowNumber,
        field: "effective_date",
        code: "invalid_date",
        message: "Effective date must use YYYY-MM-DD.",
        severity: "low",
        status: "open",
        value: row.effective_date || null,
      });
    }
  });

  return exceptions;
}

async function claimRun(runId: string, organisationId: string) {
  const [claimed] = await db
    .update(runsTable)
    .set({
      status: "running",
      startedAt: new Date(),
      retryCount: sql`${runsTable.retryCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runsTable.id, runId),
        eq(runsTable.organisationId, organisationId),
        inArray(runsTable.status, ["queued", "failed"]),
        lt(runsTable.retryCount, MAX_RETRIES),
      ),
    )
    .returning();
  return claimed;
}

export async function processRunForOrganisation(
  runId: string,
  organisationId: string,
  actor: ProcessingActor,
) {
  const claimed = await claimRun(runId, organisationId);
  if (!claimed) {
    const [existing] = await db
      .select()
      .from(runsTable)
      .where(
        and(eq(runsTable.id, runId), eq(runsTable.organisationId, organisationId)),
      )
      .limit(1);
    return existing;
  }

  try {
    const file = await storage.getObjectEntityFile(claimed.objectPath);
    const response = await storage.downloadObject(file);
    const content = await response.text();
    const rows = parseCsv(content);
    const exceptions = buildExceptions(claimed.id, organisationId, rows);
    const finalStatus = exceptions.length > 0 ? "partial" : "succeeded";

    await db.transaction(async (tx) => {
      if (exceptions.length > 0) {
        await tx.insert(validationExceptionsTable).values(exceptions);
      }
      await tx
        .update(runsTable)
        .set({
          status: finalStatus,
          recordCount: rows.length,
          exceptionCount: exceptions.length,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(runsTable.id, claimed.id));
      await tx.insert(auditEventsTable).values({
        organisationId,
        action: "run.processed",
        entityType: "run",
        entityId: claimed.id,
        actor: actor.name,
        role: actor.role,
        metadata: {
          recordCount: rows.length,
          exceptionCount: exceptions.length,
          status: finalStatus,
        },
      });
    });
  } catch (error) {
    await db
      .update(runsTable)
      .set({
        status: "failed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runsTable.id, claimed.id));
    throw error;
  }

  const [processed] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, claimed.id))
    .limit(1);
  return processed;
}

export async function claimAndProcessQueuedRuns(
  organisationId: string,
  maxRuns: number,
  actor: ProcessingActor,
) {
  const queuedRuns = await db
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(
      and(
        eq(runsTable.organisationId, organisationId),
        eq(runsTable.status, "queued"),
      ),
    )
    .limit(maxRuns);

  let processedCount = 0;
  for (const run of queuedRuns) {
    const result = await processRunForOrganisation(run.id, organisationId, actor);
    if (result?.status !== "queued" && result?.status !== "running") {
      processedCount += 1;
    }
  }
  return queuedRuns.map((run) => run.id).slice(0, processedCount);
}