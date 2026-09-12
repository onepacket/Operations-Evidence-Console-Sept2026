import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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

export const runsTable = pgTable("operations_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisationsTable.id, { onDelete: "cascade" }),
  createdByMemberId: uuid("created_by_member_id")
    .notNull()
    .references(() => membersTable.id),
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

export const inboundDeliveriesTable = pgTable(
  "operations_inbound_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: text("delivery_id").notNull().unique(),
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

export const insertRunSchema = createInsertSchema(runsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  completedAt: true,
});
export type InsertRun = z.infer<typeof insertRunSchema>;
export type Run = typeof runsTable.$inferSelect;

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

export const insertAuditEventSchema = createInsertSchema(auditEventsTable).omit(
  { id: true, createdAt: true },
);
export type InsertAuditEvent = z.infer<typeof insertAuditEventSchema>;
export type AuditEvent = typeof auditEventsTable.$inferSelect;

export const insertInboundDeliverySchema = createInsertSchema(
  inboundDeliveriesTable,
).omit({ id: true, receivedAt: true, processedAt: true });
export type InsertInboundDelivery = z.infer<
  typeof insertInboundDeliverySchema
>;
export type InboundDelivery = typeof inboundDeliveriesTable.$inferSelect;