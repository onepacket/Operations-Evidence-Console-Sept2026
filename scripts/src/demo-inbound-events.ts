import { createHmac, randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { db, organisationsTable, runsTable } from "@workspace/db";

const secret =
  process.env.INBOUND_WEBHOOK_SECRET ?? process.env.SESSION_SECRET;
if (!secret) {
  throw new Error(
    "INBOUND_WEBHOOK_SECRET or SESSION_SECRET must be configured.",
  );
}

const apiBaseUrl =
  process.env.OPERATIONS_API_URL ?? "http://127.0.0.1:8080/api";
const source = "prompt-4-demo";

const requestedOrganisationId = process.argv[2];
const requestedRunId = process.argv[3];
const [organisation] = requestedOrganisationId
  ? await db
      .select({ id: organisationsTable.id })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, requestedOrganisationId))
      .limit(1)
  : await db
      .select({ id: organisationsTable.id })
      .from(organisationsTable)
      .limit(1);
if (!organisation) {
  throw new Error("No organisation was found for the demonstration.");
}

const [run] = requestedRunId
  ? await db
      .select({ id: runsTable.id })
      .from(runsTable)
      .where(eq(runsTable.id, requestedRunId))
      .limit(1)
  : await db
      .select({ id: runsTable.id })
      .from(runsTable)
      .where(eq(runsTable.organisationId, organisation.id))
      .orderBy(desc(runsTable.createdAt))
      .limit(1);
if (!run) {
  throw new Error(
    "No run was found. Seed or create a run before executing the demonstration.",
  );
}

const acceptedEventId = `demo-${randomUUID()}`;

function signature(timestamp: number, rawBody: string, signingSecret: string) {
  return createHmac("sha256", signingSecret)
    .update(`${timestamp}.${source}.${rawBody}`)
    .digest("hex");
}

async function deliver({
  label,
  eventId,
  timestamp,
  signingSecret,
  expectedStatus,
}: {
  label: string;
  eventId: string;
  timestamp: number;
  signingSecret: string;
  expectedStatus: number;
}) {
  const rawBody = JSON.stringify({
    eventId,
    organisationId: organisation.id,
    eventType: "run.process",
    payload: { runId: run.id },
  });
  const response = await fetch(`${apiBaseUrl}/webhooks/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-operations-source": source,
      "x-operations-delivery": randomUUID(),
      "x-operations-timestamp": String(timestamp),
      "x-operations-signature": signature(timestamp, rawBody, signingSecret),
    },
    body: rawBody,
  });
  const responseBody = await response.text();
  console.log(`${label}: ${response.status} ${responseBody}`);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${label} expected HTTP ${expectedStatus}, received ${response.status}.`,
    );
  }
}

const now = Math.floor(Date.now() / 1000);
await deliver({
  label: "valid",
  eventId: acceptedEventId,
  timestamp: now,
  signingSecret: secret,
  expectedStatus: 202,
});
await deliver({
  label: "forged",
  eventId: `forged-${randomUUID()}`,
  timestamp: now,
  signingSecret: `${secret}-forged`,
  expectedStatus: 401,
});
await deliver({
  label: "stale",
  eventId: `stale-${randomUUID()}`,
  timestamp: now - 301,
  signingSecret: secret,
  expectedStatus: 408,
});
await deliver({
  label: "repeated",
  eventId: acceptedEventId,
  timestamp: Math.floor(Date.now() / 1000),
  signingSecret: secret,
  expectedStatus: 409,
});