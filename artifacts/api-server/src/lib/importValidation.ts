import { z } from "zod";

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

export function processingStatus(exceptionCount: number): "succeeded" | "partial" {
  return exceptionCount > 0 ? "partial" : "succeeded";
}

export type InputRow = Record<string, unknown>;

export type ValidationException = {
  organisationId: string;
  runId: string;
  rowNumber: number;
  field: string;
  code: string;
  message: string;
  severity: "low" | "medium" | "high";
  status: "open";
  value: string | null;
};

export class PipelineValidationError extends Error {}

export const expectedInputRowSchema = z
  .object({
    record_id: z.string().trim().min(1, "Record ID is required."),
    email: z.string().trim().email("Email must be a valid address."),
    amount: z
      .union([z.number(), z.string().trim().min(1)])
      .refine(
        (value) => Number.isFinite(Number(value)) && Number(value) > 0,
        "Amount must be a positive number.",
      ),
    effective_date: z
      .string()
      .refine((value) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(parsed.getTime()) &&
          parsed.toISOString().slice(0, 10) === value;
      }, "Effective date must be a valid calendar date using YYYY-MM-DD."),
  })
  .strict();

function splitCsvRow(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function parseCsv(content: string): InputRow[] {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headerCounts = new Map<string, number>();
  const headers = splitCsvRow(lines[0] ?? "").map((rawHeader, index) => {
    const header = rawHeader.toLowerCase();
    if (!header) return `column_${index + 1}`;
    const occurrence = (headerCounts.get(header) ?? 0) + 1;
    headerCounts.set(header, occurrence);
    return occurrence === 1 ? header : `duplicate_${header}_${occurrence}`;
  });
  return lines.slice(1).map((line) => {
    const values = splitCsvRow(line);
    const row = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    );
    values.slice(headers.length).forEach((value, index) => {
      row[`column_${headers.length + index + 1}`] = value;
    });
    return row;
  });
}

function parseJson(content: string): InputRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PipelineValidationError("JSON file is malformed.");
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : null;
  if (!rows || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new PipelineValidationError("JSON imports must contain an array of row objects.");
  }
  return rows as InputRow[];
}

export function parseRecords(
  content: string,
  fileName: string,
  fileType: string,
): InputRow[] {
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension === "json" || fileType.includes("json")) return parseJson(content);
  if (extension === "csv" || fileType === "text/csv") return parseCsv(content);
  throw new PipelineValidationError("Only CSV and JSON files are supported.");
}

function valueAsText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function buildExceptions(
  runId: string,
  organisationId: string,
  rows: InputRow[],
): ValidationException[] {
  const exceptions: ValidationException[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const result = expectedInputRowSchema.safeParse(row);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const fields =
          issue.code === "unrecognized_keys"
            ? issue.keys
            : [String(issue.path[0] ?? "_row")];
        for (const field of fields) {
          exceptions.push({
            organisationId,
            runId,
            rowNumber,
            field,
            code: issue.code,
            message:
              issue.code === "unrecognized_keys"
                ? `Field "${field}" is not part of the expected input schema.`
                : issue.message,
            severity:
              field === "effective_date"
                ? "low"
                : field === "email"
                  ? "medium"
                  : "high",
            status: "open",
            value: valueAsText(row[field]),
          });
        }
      }
    }
  });
  return exceptions;
}

export function buildStoredRows(
  rows: InputRow[],
  exceptions: Array<Pick<ValidationException, "rowNumber">>,
  context: { organisationId: string; importId: string; runId: string },
) {
  return rows.map((data, index) => {
    const rowNumber = index + 2;
    return {
      ...context,
      rowNumber,
      accepted: !exceptions.some((item) => item.rowNumber === rowNumber),
      data,
    };
  });
}

const ACCEPTED_UPLOAD_TYPES = new Set([
  "text/csv",
  "application/json",
  "application/vnd.api+json",
]);

export function validateUploadMetadata(input: {
  name: string;
  size: number;
  contentType: string;
}): { status: 413 | 415; error: string } | null {
  const extension = input.name.toLowerCase().split(".").pop();
  const isAcceptedType =
    ACCEPTED_UPLOAD_TYPES.has(input.contentType) ||
    (input.contentType === "application/octet-stream" &&
      (extension === "csv" || extension === "json"));
  if (!isAcceptedType) {
    return { status: 415, error: "Only CSV and JSON files are supported." };
  }
  if (input.size > MAX_UPLOAD_BYTES) {
    return { status: 413, error: "Files must be 250 MB or smaller." };
  }
  return null;
}