import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildExceptions,
  buildStoredRows,
  MAX_UPLOAD_BYTES,
  parseRecords,
  validateUploadMetadata,
} from "./importValidation.ts";

describe("import validation", () => {
  it("parses valid CSV and JSON records", () => {
    const csv = parseRecords(
      'record_id,email,amount,effective_date\n1,"person@example.com",12.50,2026-09-12',
      "records.csv",
      "text/csv",
    );
    const json = parseRecords(
      JSON.stringify({ rows: [{ record_id: "2", email: "two@example.com", amount: 8, effective_date: "2026-09-13" }] }),
      "records.json",
      "application/json",
    );

    assert.deepEqual(csv, [{
      record_id: "1",
      email: "person@example.com",
      amount: "12.50",
      effective_date: "2026-09-12",
    }]);
    assert.equal(json[0]?.record_id, "2");
    assert.deepEqual(buildExceptions("run", "org", [...csv, ...json]), []);
  });

  it("returns field, value, and rule-specific exceptions for invalid rows", () => {
    const [record, email, amount, date] = buildExceptions("run", "org", [{
      record_id: "",
      email: "not-an-email",
      amount: "-4",
      effective_date: "12/09/2026",
    }]);

    assert.deepEqual(
      [record, email, amount, date].map(({ field, value, code }) => ({ field, value, code })),
      [
        { field: "record_id", value: "", code: "too_small" },
        { field: "email", value: "not-an-email", code: "invalid_string" },
        { field: "amount", value: "-4", code: "custom" },
        { field: "effective_date", value: "12/09/2026", code: "custom" },
      ],
    );
  });

  it("builds accepted and rejected rows in one run persistence batch", () => {
    const rows = [
      { record_id: "1", email: "valid@example.com", amount: "10", effective_date: "2026-09-12" },
      { record_id: "2", email: "invalid", amount: "10", effective_date: "2026-09-12" },
    ];
    const exceptions = buildExceptions("run-1", "org-1", rows);
    const stored = buildStoredRows(rows, exceptions, {
      organisationId: "org-1",
      importId: "import-1",
      runId: "run-1",
    });

    assert.deepEqual(stored.map(({ runId, importId, rowNumber, accepted }) => ({
      runId,
      importId,
      rowNumber,
      accepted,
    })), [
      { runId: "run-1", importId: "import-1", rowNumber: 2, accepted: true },
      { runId: "run-1", importId: "import-1", rowNumber: 3, accepted: false },
    ]);
  });

  it("rejects oversized and unsupported uploads with clear responses", () => {
    assert.deepEqual(
      validateUploadMetadata({ name: "records.csv", size: MAX_UPLOAD_BYTES + 1, contentType: "text/csv" }),
      { status: 413, error: "Files must be 250 MB or smaller." },
    );
    assert.deepEqual(
      validateUploadMetadata({ name: "records.xlsx", size: 100, contentType: "application/vnd.ms-excel" }),
      { status: 415, error: "Only CSV and JSON files are supported." },
    );
  });
});