import { db, organisationsTable } from "@workspace/db";

import { logger } from "./logger";
import { processPendingInboundDeliveries } from "./inboundProcessing";
import { claimAndProcessQueuedRuns } from "./processing";

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_RUNS_PER_ORGANISATION = 10;
const PROCESSING_TIMEOUT_MS = 4 * 60_000;

let schedulerRunning = false;
const activeControllers = new Set<AbortController>();
let activeSweep: Promise<void> | null = null;

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  activeControllers.add(controller);
  const timer = setTimeout(
    () => controller.abort(new Error(`Scheduled processing exceeded ${timeoutMs} ms.`)),
    timeoutMs,
  );
  timer.unref();
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    activeControllers.delete(controller);
  }
}

async function processAllOrganisations() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const organisations = await db
      .select({ id: organisationsTable.id })
      .from(organisationsTable);
    await Promise.all(organisations.map(async (organisation) => {
      try {
        const processed = await withTimeout(
          async (signal) => {
            const runIds = await claimAndProcessQueuedRuns(
              organisation.id,
              MAX_RUNS_PER_ORGANISATION,
              {
                id: "operations-scheduler",
                name: "Operations scheduler",
                role: "administrator",
              },
              signal,
            );
            const deliveryIds = await processPendingInboundDeliveries(
              organisation.id,
              MAX_RUNS_PER_ORGANISATION,
              signal,
            );
            return { runIds, deliveryIds };
          },
          PROCESSING_TIMEOUT_MS,
        );
        if (processed.runIds.length > 0 || processed.deliveryIds.length > 0) {
          logger.info(
            {
              organisationId: organisation.id,
              runIds: processed.runIds,
              deliveryIds: processed.deliveryIds,
            },
            "Scheduled operations processing completed",
          );
        }
      } catch (error) {
        logger.error(
          { err: error, organisationId: organisation.id },
          "Scheduled organisation processing failed",
        );
      }
    }));
  } catch (error) {
    logger.error({ err: error }, "Scheduled import processing failed");
  } finally {
    schedulerRunning = false;
  }
}

export function startProcessingScheduler() {
  const configuredInterval = Number(
    process.env.OPERATIONS_SCHEDULER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
  );
  const intervalMs =
    Number.isFinite(configuredInterval) && configuredInterval >= 10_000
      ? configuredInterval
      : DEFAULT_INTERVAL_MS;

  const runSweep = () => {
    if (activeSweep) return;
    activeSweep = processAllOrganisations().finally(() => {
      activeSweep = null;
    });
  };
  const initialRun = setTimeout(runSweep, 1_000);
  initialRun.unref();
  const timer = setInterval(runSweep, intervalMs);
  timer.unref();
  logger.info({ intervalMs }, "Operations import scheduler started");
  return async () => {
    clearTimeout(initialRun);
    clearInterval(timer);
    for (const controller of activeControllers) {
      controller.abort(new Error("Operations scheduler is shutting down."));
    }
    if (activeSweep) {
      await Promise.race([
        activeSweep,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  };
}