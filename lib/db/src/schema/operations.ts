import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const roleEnum = pgEnum("operations_role", [
  "analyst",
  "administrator",
  "auditor",
]);
export const runStatusEnum = pgEnum("operations_run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "partial",
]);
export const summaryStatusEnum = pgEnum("operations_summary_status", [
  "not_started",
  "generating",
  "ready",
  "failed",
]);
export const exceptionSeverityEnum = pgEnum("operations_exception_severity", [
  "low",
  "medium",
  "high",
  "critical",
]);
export const exceptionStatusEnum = pgEnum("operations_exception_status", [
  "open",
  "reviewed",
  "waived",
]);
export const actionStatusEnum = pgEnum("operations_action_status", [
  "requested",
  "approved",
  "rejected",
  "running",
  "completed",
  "failed",
]);

export const organisationsTable = pgTable("operations_organisations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  retentionDays: integer("retention_days").notNull().default(365),
  requireApproval: boolean("require_approval").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const membersTable = pgTable("operations_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisationsTable.id, { onDelete: "cascade" }),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const importsTable = pgTable(
  "operations_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    uploadedByMemberId: uuid("uploaded_by_member_id")
      .notNull()
      .references(() => membersTable.id),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    fileSize: integer("file_size").notNull(),
    objectPath: text("object_path").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("operations_imports_org_content_hash_unique").on(
      table.organisationId,
      table.contentHash,
    ),
  ],
);

export const runsTable = pgTable("operations_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisationsTable.id, { onDelete: "cascade" }),
  createdByMemberId: uuid("created_by_member_id")
    .notNull()
    .references(() => membersTable.id),
  importId: uuid("import_id").references(() => importsTable.id, {
    onDelete: "cascade",
  }),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull(),
  objectPath: text("object_path").notNull(),
  status: runStatusEnum("status").notNull().default("queued"),
  recordCount: integer("record_count").notNull().default(0),
  exceptionCount: integer("exception_count").notNull().default(0),
  retryCount: integer("retry_count").notNull().default(0),
  summaryStatus: summaryStatusEnum("summary_status")
    .notNull()
    .default("not_started"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const importRowsTable = pgTable("operations_import_rows", {
  id: uuid("id").defaultRandom().primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisationsTable.id, { onDelete: "cascade" }),
  importId: uuid("import_id")
    .notNull()
    .references(() => importsTable.id, { onDelete: "cascade" }),
  runId: uuid("run_id")
    .notNull()
    .references(() => runsTable.id, { onDelete: "cascade" }),
  rowNumber: integer("row_number").notNull(),
  accepted: boolean("accepted").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const validationExceptionsTable = pgTable(
  "operations_validation_exceptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    rowId: uuid("row_id").references(() => importRowsTable.id, {
      onDelete: "cascade",
    }),
    rowNumber: integer("row_number").notNull(),
    field: text("field").notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    severity: exceptionSeverityEnum("severity").notNull(),
    status: exceptionStatusEnum("status").notNull().default("open"),
    value: text("value"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const evidenceSummariesTable = pgTable(
  "operations_evidence_summaries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" })
      .unique(),
    headline: text("headline").notNull(),
    overview: text("overview").notNull(),
    riskLevel: exceptionSeverityEnum("risk_level").notNull(),
    findings: jsonb("findings").$type<
      Array<{ title: string; detail: string; severity: string }>
    >().notNull(),
    model: text("model").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const actionRequestsTable = pgTable(
  "operations_action_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    status: actionStatusEnum("status").notNull().default("requested"),
    requestedByMemberId: uuid("requested_by_member_id")
      .notNull()
      .references(() => membersTable.id),
    decidedByMemberId: uuid("decided_by_member_id").references(
      () => membersTable.id,
    ),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    result: text("result"),
  },
);

export const approvalsTable = pgTable("operations_approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisationsTable.id, { onDelete: "cascade" }),
  actionRequestId: uuid("action_request_id")
    .notNull()
    .references(() => actionRequestsTable.id, { onDelete: "cascade" })
    .unique(),
  decidedByMemberId: uuid("decided_by_member_id")
    .notNull()
    .references(() => membersTable.id),
  decision: text("decision", { enum: ["approved", "rejected"] }).notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const auditEventsTable = pgTable("operations_audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisationsTable.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  actor: text("actor").notNull(),
  role: roleEnum("role").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const inboundRefusalAuditTable = pgTable(
  "operations_inbound_refusal_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organisationId: text("organisation_id"),
    verifiedOrganisationId: uuid("verified_organisation_id").references(
      () => organisationsTable.id,
      { onDelete: "set null" },
    ),
    source: text("source").notNull(),
    externalId: text("external_id"),
    deliveryId: text("delivery_id"),
    reason: text("reason").notNull(),
    statusCode: integer("status_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const inboundDeliveriesTable = pgTable(
  "operations_inbound_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: text("delivery_id").notNull().unique(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    eventId: text("event_id").notNull(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisationsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("operations_inbound_source_external_unique").on(
      table.source,
      table.externalId,
    ),
  ],
);

export const insertOrganisationSchema = createInsertSchema(
  organisationsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrganisation = z.infer<typeof insertOrganisationSchema>;
export type Organisation = typeof organisationsTable.$inferSelect;

export const insertMemberSchema = createInsertSchema(membersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMember = z.infer<typeof insertMemberSchema>;
export type Member = typeof membersTable.$inferSelect;

export const insertImportSchema = createInsertSchema(importsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertImport = z.infer<typeof insertImportSchema>;
export type Import = typeof importsTable.$inferSelect;

export const insertRunSchema = createInsertSchema(runsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  completedAt: true,
});
export type InsertRun = z.infer<typeof insertRunSchema>;
export type Run = typeof runsTable.$inferSelect;

export const insertImportRowSchema = createInsertSchema(importRowsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertImportRow = z.infer<typeof insertImportRowSchema>;
export type ImportRow = typeof importRowsTable.$inferSelect;

export const insertValidationExceptionSchema = createInsertSchema(
  validationExceptionsTable,
).omit({ id: true, createdAt: true });
export type InsertValidationException = z.infer<
  typeof insertValidationExceptionSchema
>;
export type ValidationException =
  typeof validationExceptionsTable.$inferSelect;

export const insertEvidenceSummarySchema = createInsertSchema(
  evidenceSummariesTable,
).omit({ id: true, generatedAt: true });
export type InsertEvidenceSummary = z.infer<
  typeof insertEvidenceSummarySchema
>;
export type EvidenceSummary = typeof evidenceSummariesTable.$inferSelect;

export const insertActionRequestSchema = createInsertSchema(
  actionRequestsTable,
).omit({ id: true, requestedAt: true, decidedAt: true });
export type InsertActionRequest = z.infer<typeof insertActionRequestSchema>;
export type ActionRequest = typeof actionRequestsTable.$inferSelect;

export const insertApprovalSchema = createInsertSchema(approvalsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertApproval = z.infer<typeof insertApprovalSchema>;
export type Approval = typeof approvalsTable.$inferSelect;

export const insertAuditEventSchema = createInsertSchema(auditEventsTable).omit(
  { id: true, createdAt: true },
);
export type InsertAuditEvent = z.infer<typeof insertAuditEventSchema>;
export type AuditEvent = typeof auditEventsTable.$inferSelect;

export const insertInboundRefusalAuditSchema = createInsertSchema(
  inboundRefusalAuditTable,
).omit({ id: true, createdAt: true });
export type InsertInboundRefusalAudit = z.infer<
  typeof insertInboundRefusalAuditSchema
>;
export type InboundRefusalAudit =
  typeof inboundRefusalAuditTable.$inferSelect;

export const insertInboundDeliverySchema = createInsertSchema(
  inboundDeliveriesTable,
).omit({ id: true, receivedAt: true, processedAt: true });
export type InsertInboundDelivery = z.infer<
  typeof insertInboundDeliverySchema
>;
export type InboundDelivery = typeof inboundDeliveriesTable.$inferSelect;