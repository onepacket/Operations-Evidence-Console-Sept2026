import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";

import {
  auditEventsTable,
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
} from "../lib/processing";
import { recordInboundRefusal } from "../lib/inboundAudit";
import { applyInboundDelivery } from "../lib/inboundProcessing";
import { logger } from "../lib/logger";

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

async function refuseInboundEvent(
  req: Request,
  res: Response,
  {
    status,
    reason,
    source,
    externalId,
    organisationId,
    verifiedOrganisationId,
    deliveryId,
  }: {
    status: number;
    reason: string;
    source: string;
    externalId?: string;
    organisationId?: string;
    verifiedOrganisationId?: string;
    deliveryId?: string;
  },
) {
  req.log.warn(
    { reason, source, externalId, organisationId, deliveryId },
    "Inbound event refused",
  );
  try {
    await recordInboundRefusal({
      status,
      reason,
      source,
      externalId,
      organisationId,
      verifiedOrganisationId,
      deliveryId,
    });
  } catch (error) {
    req.log.error({ err: error, reason }, "Could not persist inbound refusal ledger");
  }
  res.status(status).json({ error: reason });
}

router.post("/webhooks/inbound", async (req, res): Promise<void> => {
  const source = req.header("x-operations-source") ?? "unknown";
  const rawBody = getRawBody(req);
  const untrustedBody =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};
  const refusalContext = {
    source,
    externalId:
      typeof untrustedBody.eventId === "string" ? untrustedBody.eventId : undefined,
    organisationId:
      typeof untrustedBody.organisationId === "string"
        ? untrustedBody.organisationId
        : undefined,
    deliveryId: req.header("x-operations-delivery") ?? undefined,
  };
  const headers = ReceiveInboundEventHeader.safeParse({
    "x-operations-signature": req.header("x-operations-signature"),
    "x-operations-timestamp": Number(req.header("x-operations-timestamp")),
    "x-operations-delivery": req.header("x-operations-delivery"),
    "x-operations-source": req.header("x-operations-source"),
  });
  if (!headers.success) {
    await refuseInboundEvent(req, res, {
      ...refusalContext,
      status: 401,
      reason: "Missing event signature headers",
    });
    return;
  }

  const timestamp = headers.data["x-operations-timestamp"];
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    req.log.error("Inbound webhook secret is not configured");
    res.status(500).json({ error: "Inbound events are not configured" });
    return;
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${source}.${rawBody.toString("utf8")}`)
    .digest("hex");
  if (!safeEqual(expected, headers.data["x-operations-signature"])) {
    await refuseInboundEvent(req, res, {
      ...refusalContext,
      status: 401,
      reason: "Invalid event signature",
    });
    return;
  }

  const claimedOrganisationId = refusalContext.organisationId;
  const [verifiedOrganisation] =
    claimedOrganisationId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      claimedOrganisationId,
    )
      ? await db
          .select({ id: organisationsTable.id })
          .from(organisationsTable)
          .where(eq(organisationsTable.id, claimedOrganisationId))
          .limit(1)
      : [];
  const verifiedRefusalContext = {
    ...refusalContext,
    verifiedOrganisationId: verifiedOrganisation?.id,
  };
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
    await refuseInboundEvent(req, res, {
      ...verifiedRefusalContext,
      status: 408,
      reason: "Event timestamp is outside the five-minute window",
    });
    return;
  }

  const body = ReceiveInboundEventBody.safeParse(req.body);
  if (!body.success) {
    await refuseInboundEvent(req, res, {
      ...verifiedRefusalContext,
      status: 400,
      reason: body.error.message,
    });
    return;
  }

  if (!verifiedOrganisation) {
    await refuseInboundEvent(req, res, {
      ...verifiedRefusalContext,
      status: 404,
      reason: "Organisation not found",
    });
    return;
  }

  const internalDeliveryId = createHash("sha256")
    .update(`${source}\0${body.data.eventId}`)
    .digest("hex");
  const delivery = await db.transaction(async (tx) => {
    const [stored] = await tx.insert(inboundDeliveriesTable).values({
      deliveryId: internalDeliveryId,
      source,
      externalId: body.data.eventId,
      eventId: body.data.eventId,
      organisationId: body.data.organisationId,
      eventType: body.data.eventType,
      payload: body.data.payload,
    }).onConflictDoNothing({
      target: [
        inboundDeliveriesTable.source,
        inboundDeliveriesTable.externalId,
      ],
    }).returning({ id: inboundDeliveriesTable.id });
    if (!stored) return null;
    await tx.insert(auditEventsTable).values({
      organisationId: body.data.organisationId,
      action: "inbound.accepted",
      entityType: "inbound_delivery",
      entityId: body.data.eventId,
      actor: "Inbound webhook gateway",
      role: "administrator",
      metadata: {
        source,
        externalId: body.data.eventId,
        deliveryId: headers.data["x-operations-delivery"],
        eventType: body.data.eventType,
      },
    });
    return stored;
  });
  if (!delivery) {
    await refuseInboundEvent(req, res, {
      ...verifiedRefusalContext,
      status: 409,
      reason: "A delivery with this source and external id was already received",
    });
    return;
  }

  res.status(202).json(
    ReceiveInboundEventResponse.parse({ accepted: true, deduplicated: false }),
  );
  void applyInboundDelivery(delivery.id).catch((error) => {
    logger.error(
      { err: error, deliveryId: delivery.id },
      "Accepted inbound delivery processing failed; scheduler will retry",
    );
  });
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