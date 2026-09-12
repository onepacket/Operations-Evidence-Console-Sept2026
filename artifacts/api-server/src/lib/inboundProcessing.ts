import { and, eq, isNull } from "drizzle-orm";

import { db, inboundDeliveriesTable } from "@workspace/db";

import { processRunForOrganisation } from "./processing";

const inboundActor = {
  id: "inbound-event-processor",
  name: "Signed inbound event",
  role: "administrator" as const,
};

export async function applyInboundDelivery(
  deliveryId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const [delivery] = await db
    .select()
    .from(inboundDeliveriesTable)
    .where(and(
      eq(inboundDeliveriesTable.id, deliveryId),
      isNull(inboundDeliveriesTable.processedAt),
    ))
    .limit(1);
  if (!delivery) return false;

  const runId =
    typeof delivery.payload.runId === "string"
      ? delivery.payload.runId
      : undefined;
  if (delivery.eventType === "run.process" && runId) {
    await processRunForOrganisation(
      runId,
      delivery.organisationId,
      inboundActor,
      signal,
    );
  }
  signal?.throwIfAborted();
  await db
    .update(inboundDeliveriesTable)
    .set({ processedAt: new Date() })
    .where(and(
      eq(inboundDeliveriesTable.id, delivery.id),
      isNull(inboundDeliveriesTable.processedAt),
    ));
  return true;
}

export async function processPendingInboundDeliveries(
  organisationId: string,
  maxDeliveries: number,
  signal?: AbortSignal,
) {
  const deliveries = await db
    .select({ id: inboundDeliveriesTable.id })
    .from(inboundDeliveriesTable)
    .where(and(
      eq(inboundDeliveriesTable.organisationId, organisationId),
      isNull(inboundDeliveriesTable.processedAt),
    ))
    .limit(maxDeliveries);
  const processedIds: string[] = [];
  for (const delivery of deliveries) {
    signal?.throwIfAborted();
    if (await applyInboundDelivery(delivery.id, signal)) {
      processedIds.push(delivery.id);
    }
  }
  return processedIds;
}