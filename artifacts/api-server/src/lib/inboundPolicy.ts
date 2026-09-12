import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const INBOUND_TIMESTAMP_WINDOW_SECONDS = 300;

export function isFreshInboundTimestamp(
  timestamp: number,
  nowSeconds: number,
  windowSeconds = INBOUND_TIMESTAMP_WINDOW_SECONDS,
): boolean {
  return Number.isFinite(timestamp) &&
    Math.abs(nowSeconds - timestamp) <= windowSeconds;
}

export function buildInboundSignature(input: {
  secret: string;
  timestamp: number;
  source: string;
  rawBody: string | Buffer;
}): string {
  return createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.source}.${input.rawBody.toString()}`)
    .digest("hex");
}

export function signaturesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

export function inboundDeliveryKey(source: string, externalId: string): string {
  return createHash("sha256")
    .update(`${source}\0${externalId}`)
    .digest("hex");
}

export function isOrganisationId(value: string | undefined): value is string {
  return value !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}