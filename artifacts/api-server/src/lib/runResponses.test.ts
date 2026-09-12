import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRunDetail, useExistingOrCreate } from "./runResponses.ts";

describe("run responses", () => {
  it("does not create a duplicate run on a second submit", async () => {
    const existing = { id: "run-1" };
    let creates = 0;
    const result = await useExistingOrCreate(existing, async () => {
      creates += 1;
      return { id: "run-2" };
    });

    assert.equal(result, existing);
    assert.equal(creates, 0);
  });

  it("returns accepted/rejected rows and attempt history in run detail", () => {
    const detail = buildRunDetail(
      { id: "run-1", status: "partial" },
      [
        { id: "row-1", accepted: true },
        { id: "row-2", accepted: false },
      ],
      [
        {
          id: "attempt-2",
          actor: "Ada",
          action: "run.processed",
          metadata: {
            startedAt: "2026-09-12T10:00:00.000Z",
            durationMs: 31,
            status: "partial",
          },
          createdAt: new Date("2026-09-12T10:00:01.000Z"),
        },
        {
          id: "attempt-1",
          actor: "Ada",
          action: "run.failed",
          metadata: { reason: "Invalid JSON" },
          createdAt: new Date("2026-09-12T09:00:00.000Z"),
        },
      ],
    );

    assert.deepEqual(detail.acceptedRows, [{ id: "row-1", accepted: true }]);
    assert.deepEqual(detail.rejectedRows, [{ id: "row-2", accepted: false }]);
    assert.deepEqual(detail.attempts.map(({ outcome, reason }) => ({ outcome, reason })), [
      { outcome: "partial", reason: null },
      { outcome: "failed", reason: "Invalid JSON" },
    ]);
  });
});