import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
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
import { contentHash, MAX_PROCESSING_RETRIES } from "./processingPolicy";
import {
  buildExceptions,
  buildStoredRows,
  MAX_UPLOAD_BYTES,
  parseRecords,
  processingStatus,
  PipelineValidationError,
} from "./importValidation";

const storage = new ObjectStorageService();
const MAX_RETRIES = MAX_PROCESSING_RETRIES;
const STUCK_RUN_AFTER_MS = 5 * 60 * 1000;

type ProcessingActor = Pick<Member, "id" | "name" | "role">;
export type ProcessingDependencies = {
  storage?: Pick<ObjectStorageService, "getObjectEntityFile" | "downloadObject">;
};

async function claimRun(
  runId: string,
  organisationId: string,
  actor: ProcessingActor,
) {
  const stuckBefore = new Date(Date.now() - STUCK_RUN_AFTER_MS);
  return db.transaction(async (tx) => {
    const [claimed] = await tx
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
    if (claimed && claimed.retryCount > 1) {
      await tx.insert(auditEventsTable).values({
        organisationId,
        action: "run.rerun_started",
        entityType: "run",
        entityId: claimed.id,
        actor: actor.name,
        role: actor.role,
        metadata: {
          attempt: claimed.retryCount,
          source: "shared_processing_claim",
        },
      });
    }
    return claimed;
  });
}

export async function processRunForOrganisation(
  runId: string,
  organisationId: string,
  actor: ProcessingActor,
  signal?: AbortSignal,
  dependencies: ProcessingDependencies = {},
) {
  const objectStorage = dependencies.storage ?? storage;
  const claimed = await claimRun(runId, organisationId, actor);
  if (!claimed) {
    const [existing] = await db.select().from(runsTable).where(and(eq(runsTable.id, runId), eq(runsTable.organisationId, organisationId))).limit(1);
    return existing;
  }
  const startedAt = claimed.startedAt ?? new Date();
  try {
    signal?.throwIfAborted();
    const file = await objectStorage.getObjectEntityFile(claimed.objectPath, signal);
    const [metadata] = await file.getMetadata({ timeout: 30_000 });
    signal?.throwIfAborted();
    const actualSize = Number(metadata.size ?? claimed.fileSize);
    if (actualSize > MAX_UPLOAD_BYTES) {
      throw new PipelineValidationError("Files must be 250 MB or smaller.");
    }
    const response = await objectStorage.downloadObject(file, 3600, signal);
    const contentBytes = Buffer.from(await response.arrayBuffer());
    signal?.throwIfAborted();
    const content = contentBytes.toString("utf8");
    const rows = parseRecords(content, claimed.fileName, claimed.fileType);
    if (rows.length === 0) {
      throw new PipelineValidationError("The import must contain at least one data row.");
    }
    const exceptions = buildExceptions(claimed.id, organisationId, rows);
    const finalStatus = processingStatus(exceptions.length);
    const contentDigest = contentHash(Buffer.concat([contentBytes, Buffer.from(claimed.id)]));
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
       await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${organisationId}:${contentDigest}`}))`);
      const [insertedImport] = await tx.insert(importsTable).values({
            organisationId,
            uploadedByMemberId: claimed.createdByMemberId,
            fileName: claimed.fileName,
            contentType: claimed.fileType,
            fileSize: actualSize,
            objectPath: claimed.objectPath,
            contentHash: contentDigest,
          }).onConflictDoNothing({
            target: [importsTable.organisationId, importsTable.contentHash],
          }).returning();
      const [storedImport] = insertedImport
        ? [insertedImport]
        : await tx.select().from(importsTable).where(and(
            eq(importsTable.organisationId, organisationId),
            eq(importsTable.contentHash, contentDigest),
          )).limit(1);
      await tx.delete(validationExceptionsTable).where(eq(validationExceptionsTable.runId, claimed.id));
      let storedRows = await tx.select().from(importRowsTable).where(and(
        eq(importRowsTable.organisationId, organisationId),
        eq(importRowsTable.importId, storedImport.id),
      )).orderBy(importRowsTable.rowNumber);
      if (storedRows.length === 0) {
        storedRows = await tx.insert(importRowsTable).values(buildStoredRows(
          rows,
          exceptions,
          {
            organisationId,
            importId: storedImport.id,
            runId: claimed.id,
          },
        )).returning();
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
            metadata: { recordCount: rows.length, exceptionCount: exceptions.length, status: finalStatus, startedAt: startedAt.toISOString(), durationMs, contentHash: contentDigest, reusedImport: !insertedImport },
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