import { z } from "zod";

export const llmSummarySchema = z.object({
  headline: z.string().min(1),
  headlineSourceRows: z.array(z.number().int().positive()).min(1),
  overview: z.string().min(1),
  overviewSourceRows: z.array(z.number().int().positive()).min(1),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  findings: z.array(
    z.object({
      title: z.string().min(1),
      detail: z.string().min(1),
      severity: z.enum(["low", "medium", "high", "critical"]),
      sourceRowNumbers: z.array(z.number().int().positive()).min(1),
    }).strict(),
  ),
}).strict();

export type StructuredSummary = z.infer<typeof llmSummarySchema>;

export function isTimeoutError(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string };
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return candidate.name === "APIConnectionTimeoutError" ||
    candidate.code === "ETIMEDOUT" ||
    message.includes("timeout") ||
    message.includes("timed out");
}

export function validateSummarySources(
  summary: StructuredSummary,
  sourceRows: Set<number>,
): StructuredSummary {
  const citations = [
    ...summary.headlineSourceRows,
    ...summary.overviewSourceRows,
    ...summary.findings.flatMap((finding) => finding.sourceRowNumbers),
  ];
  if (citations.some((rowNumber) => !sourceRows.has(rowNumber))) {
    throw new Error("Summary cited a row that was not supplied as evidence");
  }
  return summary;
}