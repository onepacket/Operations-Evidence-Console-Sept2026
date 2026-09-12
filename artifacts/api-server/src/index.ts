import app from "./app";
import { ensureOperationalAuditGuards } from "./lib/auditIntegrity";
import { logger } from "./lib/logger";
import { startProcessingScheduler } from "./lib/processingScheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

let stopScheduler = async () => {};
await ensureOperationalAuditGuards();
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  stopScheduler = startProcessingScheduler();
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down API server");
  await stopScheduler();
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "API server shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
