import { db, inboundRefusalAuditTable } from "@workspace/db";

export interface InboundRefusalContext {
  status: number;
  reason: string;
  source: string;
  externalId?: string;
  organisationId?: string;
  deliveryId?: string;
}

export async function recordInboundRefusal(
  context: InboundRefusalContext,
) {
  await db.insert(inboundRefusalAuditTable).values({
    organisationId: context.organisationId,
    source: context.source,
    externalId: context.externalId,
    deliveryId: context.deliveryId,
    reason: context.reason,
    statusCode: context.status,
  });
}