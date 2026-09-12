type RunRow = Record<string, unknown> & {
  accepted: boolean;
};

type RunAttempt = {
  id: string;
  actor: string;
  action: string;
  metadata: unknown;
  createdAt: Date;
};

export async function useExistingOrCreate<T>(
  existing: T | undefined,
  create: () => Promise<T>,
): Promise<T> {
  return existing ?? create();
}

export function buildRunDetail<T extends Record<string, unknown>>(
  run: T,
  rows: RunRow[],
  attempts: RunAttempt[],
) {
  return {
    ...run,
    acceptedRows: rows.filter((row) => row.accepted),
    rejectedRows: rows.filter((row) => !row.accepted),
    attempts: attempts.map((attempt) => {
      const metadata =
        attempt.metadata && typeof attempt.metadata === "object"
          ? (attempt.metadata as Record<string, unknown>)
          : {};
      return {
        id: attempt.id,
        actor: attempt.actor,
        startedAt:
          typeof metadata.startedAt === "string"
            ? metadata.startedAt
            : attempt.createdAt,
        durationMs:
          typeof metadata.durationMs === "number" ? metadata.durationMs : undefined,
        outcome:
          typeof metadata.status === "string"
            ? metadata.status
            : attempt.action === "run.failed"
              ? "failed"
              : "succeeded",
        reason: typeof metadata.reason === "string" ? metadata.reason : null,
      };
    }),
  };
}