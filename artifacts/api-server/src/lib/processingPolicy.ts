import { createHash } from "node:crypto";

export const MAX_PROCESSING_RETRIES = 3;

export type ProcessableRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial";

export function canProcessRun(
  status: ProcessableRunStatus,
  retryCount: number,
): boolean {
  return (status === "queued" || status === "failed") &&
    retryCount < MAX_PROCESSING_RETRIES;
}

export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isDuplicateImportContent(
  existingHash: string,
  incomingHash: string,
): boolean {
  return existingHash === incomingHash;
}