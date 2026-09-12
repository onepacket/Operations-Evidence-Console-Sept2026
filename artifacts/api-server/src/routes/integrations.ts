import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";

import {
  db,
  inboundDeliveriesTable,
  organisationsTable,
} from "@workspace/db";
import {
  ReceiveInboundEventBody,
  ReceiveInboundEventHeader,
  ReceiveInboundEventResponse,
  RunImportJobBody,
  RunImportJobHeader,
  RunImportJobResponse,
} from "@workspace/api-zod";

import {
  claimAndProcessQueuedRuns,
  processRunForOrganisation,
} from "../lib/processing";

const router: IRouter = Router();

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function getRawBody(req: Request): Buffer {
  return (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
}

router.post("/webhooks/inbound", async (req, res): Promise<void> => {
  const headers = ReceiveInboundEventHeader.safeParse({
    "x-operations-signature": req.header("x-operations-signature"),
    "x-operations-timestamp": Number(req.header("x-operations-timestamp")),
    "x-operations-delivery": req.header("x-operations-delivery"),
  });
  if (!headers.success) {
    res.status(401).json({ error: "Missing event signature headers" });
    return;
  }

  const timestamp = headers.data["x-operations-timestamp"];
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
    res.status(401).json({ error: "Event timestamp is outside the five-minute window" });
    return;
  }

  const secret = process.env.INBOUND_WEBHOOK_SECRET ?? process.env.SESSION_SECRET;
  if (!secret) {
    req.log.error("Inbound webhook secret is not configured");
    res.status(500).json({ error: "Inbound events are not configured" });
    return;
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${getRawBody(req).toString("utf8")}`)
    .digest("hex");
  if (!safeEqual(expected, headers.data["x-operations-signature"])) {
    res.status(401).json({ error: "Invalid event signature" });
    return;
  }

  const body = ReceiveInboundEventBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [organisation] = await db
    .select({ id: organisationsTable.id })
    .from(organisationsTable)
    .where(eq(organisationsTable.id, body.data.organisationId))
    .limit(1);
  if (!organisation) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  const [existing] = await db
    .select({ id: inboundDeliveriesTable.id })
    .from(inboundDeliveriesTable)
    .where(eq(inboundDeliveriesTable.deliveryId, headers.data["x-operations-delivery"]))
    .limit(1);
  if (existing) {
    res.status(202).json(
      ReceiveInboundEventResponse.parse({ accepted: true, deduplicated: true }),
    );
    return;
  }

  await db.insert(inboundDeliveriesTable).values({
    deliveryId: headers.data["x-operations-delivery"],
    eventId: body.data.eventId,
    organisationId: body.data.organisationId,
    eventType: body.data.eventType,
    payload: body.data.payload,
  });

  const runId =
    typeof body.data.payload.runId === "string"
      ? body.data.payload.runId
      : undefined;
  if (body.data.eventType === "run.process" && runId) {
    await processRunForOrganisation(runId, body.data.organisationId, {
      id: "external-scheduler",
      name: "Signed inbound event",
      role: "administrator",
    });
  }

  await db
    .update(inboundDeliveriesTable)
    .set({ processedAt: new Date() })
    .where(eq(inboundDeliveriesTable.deliveryId, headers.data["x-operations-delivery"]));

  res.status(202).json(
    ReceiveInboundEventResponse.parse({ accepted: true, deduplicated: false }),
  );
});

router.post("/jobs/process-imports", async (req, res): Promise<void> => {
  const header = RunImportJobHeader.safeParse({
    "x-operations-job-token": req.header("x-operations-job-token"),
  });
  const expectedToken = process.env.OPERATIONS_JOB_TOKEN ?? process.env.SESSION_SECRET;
  if (!header.success || !expectedToken || !safeEqual(header.data["x-operations-job-token"], expectedToken)) {
    res.status(401).json({ error: "Invalid job credentials" });
    return;
  }
  const body = RunImportJobBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [organisation] = await db
    .select({ id: organisationsTable.id })
    .from(organisationsTable)
    .where(eq(organisationsTable.id, body.data.organisationId))
    .limit(1);
  if (!organisation) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  const claimedRunIds = await claimAndProcessQueuedRuns(
    organisation.id,
    body.data.maxRuns,
    {
      id: "external-scheduler",
      name: "External scheduler",
      role: "administrator",
    },
  );
  res.json(
    RunImportJobResponse.parse({
      organisationId: organisation.id,
      claimedRunIds,
      processedCount: claimedRunIds.length,
    }),
  );
});

export default router;