import { createHash } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

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

type ProcessingActor = Pick<Member, "id" | "name" | "role">;
type InputRow = Record<string, unknown>;

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
  const headers = splitCsvRow(lines[0] ?? "").map((header) => header.toLowerCase());
  if (headers.some((header) => !header)) {
    throw new Error("CSV headers must not be empty.");
  }
  return lines.slice(1).map((line) =>
    Object.fromEntries(
      headers.map((header, index) => [header, splitCsvRow(line)[index] ?? ""]),
    ),
  );
}

function parseJson(content: string): InputRow[] {
  const parsed: unknown = JSON.parse(content);
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : null;
  if (!rows || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("JSON imports must contain an array of row objects.");
  }
  return rows as InputRow[];
}

function parseRecords(content: string, fileName: string, fileType: string): InputRow[] {
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension === "json" || fileType.includes("json")) return parseJson(content);
  if (extension === "csv" || fileType === "text/csv") return parseCsv(content);
  throw new Error("Only CSV and JSON files are supported.");
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
    const recordId = valueAsText(row.record_id);
    const email = valueAsText(row.email);
    const amount = valueAsText(row.amount);
    const effectiveDate = valueAsText(row.effective_date);
    if (!recordId) {
      exceptions.push({ organisationId, runId, rowNumber, field: "record_id", code: "required", message: "Record ID is required.", severity: "high", status: "open", value: recordId });
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      exceptions.push({ organisationId, runId, rowNumber, field: "email", code: "invalid_email", message: "Email must be a valid address.", severity: "medium", status: "open", value: email });
    }
    if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
      exceptions.push({ organisationId, runId, rowNumber, field: "amount", code: "invalid_amount", message: "Amount must be a positive number.", severity: "high", status: "open", value: amount });
    }
    if (!effectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      exceptions.push({ organisationId, runId, rowNumber, field: "effective_date", code: "invalid_date", message: "Effective date must use YYYY-MM-DD.", severity: "low", status: "open", value: effectiveDate });
    }
  });
  return exceptions;
}

async function claimRun(runId: string, organisationId: string) {
  const [claimed] = await db
    .update(runsTable)
    .set({ status: "running", startedAt: new Date(), retryCount: sql`${runsTable.retryCount} + 1`, updatedAt: new Date() })
    .where(and(eq(runsTable.id, runId), eq(runsTable.organisationId, organisationId), inArray(runsTable.status, ["queued", "failed"]), lt(runsTable.retryCount, MAX_RETRIES)))
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
    const [existing] = await db.select().from(runsTable).where(and(eq(runsTable.id, runId), eq(runsTable.organisationId, organisationId))).limit(1);
    return existing;
  }
  const startedAt = claimed.startedAt ?? new Date();
  try {
    const file = await storage.getObjectEntityFile(claimed.objectPath);
    const [metadata] = await file.getMetadata();
    const actualSize = Number(metadata.size ?? claimed.fileSize);
    if (actualSize > MAX_UPLOAD_BYTES) throw new Error("Files must be 250 MB or smaller.");
    const response = await storage.downloadObject(file);
    const content = await response.text();
    const rows = parseRecords(content, claimed.fileName, claimed.fileType);
    const exceptions = buildExceptions(claimed.id, organisationId, rows);
    const finalStatus = exceptions.length > 0 ? "partial" : "succeeded";
    const contentHash = createHash("sha256").update(content).digest("hex");
    const durationMs = Math.max(0, Date.now() - startedAt.getTime());

    await db.transaction(async (tx) => {
      const [existingImport] = await tx.select().from(importsTable).where(and(eq(importsTable.organisationId, organisationId), eq(importsTable.contentHash, contentHash))).limit(1);
      const [storedImport] = existingImport
        ? [existingImport]
        : await tx.insert(importsTable).values({
            organisationId,
            uploadedByMemberId: actor.id,
            fileName: claimed.fileName,
            contentType: claimed.fileType,
            fileSize: actualSize,
            objectPath: claimed.objectPath,
            contentHash,
          }).returning();
      await tx.delete(validationExceptionsTable).where(eq(validationExceptionsTable.runId, claimed.id));
      await tx.delete(importRowsTable).where(eq(importRowsTable.runId, claimed.id));
      const storedRows = await tx.insert(importRowsTable).values(rows.map((row, index) => ({
        organisationId,
        importId: storedImport.id,
        runId: claimed.id,
        rowNumber: index + 2,
        accepted: !exceptions.some((item) => item.rowNumber === index + 2),
        data: row,
      }))).returning();
      if (exceptions.length > 0) {
        await tx.insert(validationExceptionsTable).values(exceptions.map((exception) => ({
          ...exception,
          rowId: storedRows.find((row) => row.rowNumber === exception.rowNumber)?.id,
        })));
      }
      await tx.update(runsTable).set({
        importId: storedImport.id,
        status: finalStatus,
        recordCount: rows.length,
        exceptionCount: exceptions.length,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(runsTable.id, claimed.id));
      await tx.insert(auditEventsTable).values({
        organisationId,
        action: "run.processed",
        entityType: "run",
        entityId: claimed.id,
        actor: actor.name,
        role: actor.role,
        metadata: { recordCount: rows.length, exceptionCount: exceptions.length, status: finalStatus, startedAt: startedAt.toISOString(), durationMs },
      });
    });
  } catch (error) {
    await db.update(runsTable).set({ status: "failed", completedAt: new Date(), updatedAt: new Date() }).where(eq(runsTable.id, claimed.id));
    await db.insert(auditEventsTable).values({
      organisationId,
      action: "run.failed",
      entityType: "run",
      entityId: claimed.id,
      actor: actor.name,
      role: actor.role,
      metadata: { reason: error instanceof Error ? error.message : "Unknown processing failure", startedAt: startedAt.toISOString() },
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
) {
  const queuedRuns = await db.select({ id: runsTable.id }).from(runsTable).where(and(eq(runsTable.organisationId, organisationId), eq(runsTable.status, "queued"))).limit(maxRuns);
  const processedIds: string[] = [];
  for (const run of queuedRuns) {
    const result = await processRunForOrganisation(run.id, organisationId, actor);
    if (result?.status !== "queued" && result?.status !== "running") processedIds.push(run.id);
  }
  return processedIds;
}