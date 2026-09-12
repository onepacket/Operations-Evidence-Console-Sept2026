import { createHash } from "node:crypto";
import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  auditEventsTable,
  db,
  importRowsTable,
  importsTable,
  runsTable,
  validationExceptionsTable,
  type Member,
} from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";

const storage = new ObjectStorageService();
const MAX_RETRIES = 3;
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const STUCK_RUN_AFTER_MS = 5 * 60 * 1000;

type ProcessingActor = Pick<Member, "id" | "name" | "role">;
type InputRow = Record<string, unknown>;

export class PipelineValidationError extends Error {}

export const expectedInputRowSchema = z
  .object({
    record_id: z.string().trim().min(1, "Record ID is required."),
    email: z.string().trim().email("Email must be a valid address."),
    amount: z
      .union([z.number(), z.string().trim().min(1)])
      .refine(
        (value) => Number.isFinite(Number(value)) && Number(value) > 0,
        "Amount must be a positive number.",
      ),
    effective_date: z
      .string()
      .refine((value) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(parsed.getTime()) &&
          parsed.toISOString().slice(0, 10) === value;
      }, "Effective date must be a valid calendar date using YYYY-MM-DD."),
  })
  .strict();

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

function parseCsv(content: string): InputRow[] {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headerCounts = new Map<string, number>();
  const headers = splitCsvRow(lines[0] ?? "").map((rawHeader, index) => {
    const header = rawHeader.toLowerCase();
    if (!header) return `column_${index + 1}`;
    const occurrence = (headerCounts.get(header) ?? 0) + 1;
    headerCounts.set(header, occurrence);
    return occurrence === 1 ? header : `duplicate_${header}_${occurrence}`;
  });
  return lines.slice(1).map((line) => {
    const values = splitCsvRow(line);
    const row = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    );
    values.slice(headers.length).forEach((value, index) => {
      row[`column_${headers.length + index + 1}`] = value;
    });
    return row;
  });
}

function parseJson(content: string): InputRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PipelineValidationError("JSON file is malformed.");
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : null;
  if (!rows || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new PipelineValidationError("JSON imports must contain an array of row objects.");
  }
  return rows as InputRow[];
}

function parseRecords(content: string, fileName: string, fileType: string): InputRow[] {
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension === "json" || fileType.includes("json")) return parseJson(content);
  if (extension === "csv" || fileType === "text/csv") return parseCsv(content);
  throw new PipelineValidationError("Only CSV and JSON files are supported.");
}

function valueAsText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function buildExceptions(
  runId: string,
  organisationId: string,
  rows: InputRow[],
) {
  const exceptions: Array<typeof validationExceptionsTable.$inferInsert> = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const result = expectedInputRowSchema.safeParse(row);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const fields =
          issue.code === "unrecognized_keys"
            ? issue.keys
            : [String(issue.path[0] ?? "_row")];
        for (const field of fields) {
          exceptions.push({
            organisationId,
            runId,
            rowNumber,
            field,
            code: issue.code,
            message:
              issue.code === "unrecognized_keys"
                ? `Field "${field}" is not part of the expected input schema.`
                : issue.message,
            severity: field === "effective_date" ? "low" : field === "email" ? "medium" : "high",
            status: "open",
            value: valueAsText(row[field]),
          });
        }
      }
    }
  });
  return exceptions;
}

async function claimRun(runId: string, organisationId: string) {
  const stuckBefore = new Date(Date.now() - STUCK_RUN_AFTER_MS);
  const [claimed] = await db
    .update(runsTable)
    .set({ status: "running", startedAt: new Date(), retryCount: sql`${runsTable.retryCount} + 1`, updatedAt: new Date() })
    .where(and(
      eq(runsTable.id, runId),
      eq(runsTable.organisationId, organisationId),
      or(
        inArray(runsTable.status, ["queued", "failed"]),
        and(eq(runsTable.status, "running"), lte(runsTable.startedAt, stuckBefore)),
      ),
      lt(runsTable.retryCount, MAX_RETRIES),
    ))
    .returning();
  return claimed;
}

export async function processRunForOrganisation(
  runId: string,
  organisationId: string,
  actor: ProcessingActor,
  signal?: AbortSignal,
) {
  const claimed = await claimRun(runId, organisationId);
  if (!claimed) {
    const [existing] = await db.select().from(runsTable).where(and(eq(runsTable.id, runId), eq(runsTable.organisationId, organisationId))).limit(1);
    return existing;
  }
  const startedAt = claimed.startedAt ?? new Date();
  try {
    signal?.throwIfAborted();
    const file = await storage.getObjectEntityFile(claimed.objectPath, signal);
    const [metadata] = await file.getMetadata({ timeout: 30_000 });
    signal?.throwIfAborted();
    const actualSize = Number(metadata.size ?? claimed.fileSize);
    if (actualSize > MAX_UPLOAD_BYTES) {
      throw new PipelineValidationError("Files must be 250 MB or smaller.");
    }
    const response = await storage.downloadObject(file, 3600, signal);
    const contentBytes = Buffer.from(await response.arrayBuffer());
    signal?.throwIfAborted();
    const content = contentBytes.toString("utf8");
    const rows = parseRecords(content, claimed.fileName, claimed.fileType);
    if (rows.length === 0) {
      throw new PipelineValidationError("The import must contain at least one data row.");
    }
    const exceptions = buildExceptions(claimed.id, organisationId, rows);
    const finalStatus = exceptions.length > 0 ? "partial" : "succeeded";
    const contentHash = createHash("sha256").update(contentBytes).digest("hex");
    const durationMs = Math.max(0, Date.now() - startedAt.getTime());

    await db.transaction(async (tx) => {
      const [ownedRun] = await tx.update(runsTable).set({
        status: finalStatus,
        recordCount: rows.length,
        exceptionCount: exceptions.length,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(runsTable.id, claimed.id),
        eq(runsTable.organisationId, organisationId),
        eq(runsTable.status, "running"),
        eq(runsTable.startedAt, startedAt),
      )).returning({ id: runsTable.id });
      if (!ownedRun) return;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${organisationId}:${contentHash}`}))`);
      const [insertedImport] = await tx.insert(importsTable).values({
            organisationId,
            uploadedByMemberId: claimed.createdByMemberId,
            fileName: claimed.fileName,
            contentType: claimed.fileType,
            fileSize: actualSize,
            objectPath: claimed.objectPath,
            contentHash,
          }).onConflictDoNothing({
            target: [importsTable.organisationId, importsTable.contentHash],
          }).returning();
      const [storedImport] = insertedImport
        ? [insertedImport]
        : await tx.select().from(importsTable).where(and(
            eq(importsTable.organisationId, organisationId),
            eq(importsTable.contentHash, contentHash),
          )).limit(1);
      await tx.delete(validationExceptionsTable).where(eq(validationExceptionsTable.runId, claimed.id));
      let storedRows = await tx.select().from(importRowsTable).where(and(
        eq(importRowsTable.organisationId, organisationId),
        eq(importRowsTable.importId, storedImport.id),
      )).orderBy(importRowsTable.rowNumber);
      if (storedRows.length === 0) {
        storedRows = await tx.insert(importRowsTable).values(rows.map((row, index) => ({
          organisationId,
          importId: storedImport.id,
          runId: claimed.id,
          rowNumber: index + 2,
          accepted: !exceptions.some((item) => item.rowNumber === index + 2),
          data: row,
        }))).returning();
      }
      if (exceptions.length > 0) {
        await tx.insert(validationExceptionsTable).values(exceptions.map((exception) => ({
          ...exception,
          rowId: storedRows.find((row) => row.rowNumber === exception.rowNumber)?.id,
        })));
      }
      await tx.update(runsTable).set({
        importId: storedImport.id,
        updatedAt: new Date(),
      }).where(and(
        eq(runsTable.id, claimed.id),
        eq(runsTable.organisationId, organisationId),
        eq(runsTable.startedAt, startedAt),
      ));
      await tx.insert(auditEventsTable).values({
        organisationId,
        action: "run.processed",
        entityType: "run",
        entityId: claimed.id,
        actor: actor.name,
        role: actor.role,
        metadata: { recordCount: rows.length, exceptionCount: exceptions.length, status: finalStatus, startedAt: startedAt.toISOString(), durationMs, contentHash, reusedImport: !insertedImport },
      });
    });
  } catch (error) {
    const retryable = !(error instanceof PipelineValidationError);
    const final = !retryable || claimed.retryCount >= MAX_RETRIES;
    const completedAt = new Date();
    await db.transaction(async (tx) => {
      const [ownedRun] = await tx.update(runsTable).set({
        status: "failed",
        retryCount: final ? MAX_RETRIES : claimed.retryCount,
        completedAt,
        updatedAt: completedAt,
      }).where(and(
        eq(runsTable.id, claimed.id),
        eq(runsTable.organisationId, organisationId),
        eq(runsTable.status, "running"),
        eq(runsTable.startedAt, startedAt),
      )).returning({ id: runsTable.id });
      if (!ownedRun) return;
      await tx.insert(auditEventsTable).values({
        organisationId,
        action: "run.failed",
        entityType: "run",
        entityId: claimed.id,
        actor: actor.name,
        role: actor.role,
        metadata: {
          reason: error instanceof Error ? error.message : "Unknown processing failure",
          startedAt: startedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          retryable,
          final,
          attempt: claimed.retryCount,
          maxAttempts: MAX_RETRIES,
        },
      });
    });
    throw error;
  }
  const [processed] = await db.select().from(runsTable).where(eq(runsTable.id, claimed.id)).limit(1);
  return processed;
}

export async function claimAndProcessQueuedRuns(
  organisationId: string,
  maxRuns: number,
  actor: ProcessingActor,
  signal?: AbortSignal,
) {
  const stuckBefore = new Date(Date.now() - STUCK_RUN_AFTER_MS);
  const exhaustedStuckRuns = await db.select({
    id: runsTable.id,
    startedAt: runsTable.startedAt,
    retryCount: runsTable.retryCount,
  }).from(runsTable).where(and(
    eq(runsTable.organisationId, organisationId),
    eq(runsTable.status, "running"),
    gte(runsTable.retryCount, MAX_RETRIES),
    lte(runsTable.startedAt, stuckBefore),
  )).limit(maxRuns);
  const finalizedIds: string[] = [];
  for (const run of exhaustedStuckRuns) {
    const attemptStartedAt = run.startedAt;
    if (!attemptStartedAt) continue;
    await db.transaction(async (tx) => {
      const completedAt = new Date();
      const [finalized] = await tx.update(runsTable).set({
        status: "failed",
        completedAt,
        updatedAt: completedAt,
      }).where(and(
        eq(runsTable.id, run.id),
        eq(runsTable.organisationId, organisationId),
        eq(runsTable.status, "running"),
        eq(runsTable.startedAt, attemptStartedAt),
        gte(runsTable.retryCount, MAX_RETRIES),
      )).returning({ id: runsTable.id });
      if (!finalized) return;
      await tx.insert(auditEventsTable).values({
        organisationId,
        action: "run.failed",
        entityType: "run",
        entityId: run.id,
        actor: actor.name,
        role: actor.role,
        metadata: {
          reason: `Processing timed out after ${STUCK_RUN_AFTER_MS} ms on the final attempt.`,
          startedAt: attemptStartedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - attemptStartedAt.getTime()),
          retryable: true,
          final: true,
          attempt: run.retryCount,
          maxAttempts: MAX_RETRIES,
        },
      });
      finalizedIds.push(run.id);
    });
  }
  const queuedRuns = await db.select({ id: runsTable.id }).from(runsTable).where(and(
    eq(runsTable.organisationId, organisationId),
    lt(runsTable.retryCount, MAX_RETRIES),
    or(
      inArray(runsTable.status, ["queued", "failed"]),
      and(eq(runsTable.status, "running"), lte(runsTable.startedAt, stuckBefore)),
    ),
  )).limit(maxRuns);
  const processedIds: string[] = [...finalizedIds];
  for (const run of queuedRuns) {
    signal?.throwIfAborted();
    try {
      const result = await processRunForOrganisation(
        run.id,
        organisationId,
        actor,
        signal,
      );
      if (result?.status !== "queued" && result?.status !== "running") processedIds.push(run.id);
    } catch {
      processedIds.push(run.id);
    }
  }
  return processedIds;
}