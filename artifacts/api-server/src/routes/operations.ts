import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  actionRequestsTable,
  auditEventsTable,
  db,
  evidenceSummariesTable,
  importRowsTable,
  organisationsTable,
  runsTable,
  validationExceptionsTable,
} from "@workspace/db";
import {
  ApproveActionParams,
  ApproveActionResponse,
  CreateRunBody,
  CreateRunResponse,
  GenerateRunSummaryBody,
  GenerateRunSummaryParams,
  GenerateRunSummaryResponse,
  GetCurrentUserResponse,
  GetDashboardResponse,
  GetRunParams,
  GetRunResponse,
  GetRunSummaryParams,
  GetRunSummaryResponse,
  GetSettingsResponse,
  ListActionsQueryParams,
  ListActionsResponse,
  ListAuditEventsQueryParams,
  ListAuditEventsResponse,
  ListRunExceptionsParams,
  ListRunExceptionsResponse,
  ListRunsQueryParams,
  ListRunsResponse,
  ProcessRunParams,
  ProcessRunResponse,
  RejectActionBody,
  RejectActionParams,
  RejectActionResponse,
  RequestActionBody,
  RequestActionResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";

import {
  getOperationsContext,
  requireOperationsAuth,
  requireRole,
} from "../lib/auth";
import { processRunForOrganisation } from "../lib/processing";

const router: IRouter = Router();
router.use(requireOperationsAuth);

function runView(run: typeof runsTable.$inferSelect) {
  return {
    id: run.id,
    fileName: run.fileName,
    fileType: run.fileType,
    status: run.status,
    recordCount: run.recordCount,
    exceptionCount: run.exceptionCount,
    retryCount: run.retryCount,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    summaryStatus: run.summaryStatus,
  };
}

function actionView(action: typeof actionRequestsTable.$inferSelect) {
  return {
    id: action.id,
    runId: action.runId,
    actionType: action.actionType,
    title: action.title,
    rationale: action.rationale,
    status: action.status,
    requestedBy: action.requestedByMemberId,
    requestedAt: action.requestedAt,
    decidedAt: action.decidedAt,
    decisionNote: action.decisionNote,
    result: action.result,
  };
}

function exceptionView(
  exception: typeof validationExceptionsTable.$inferSelect,
) {
  return {
    id: exception.id,
    runId: exception.runId,
    rowNumber: exception.rowNumber,
    field: exception.field,
    code: exception.code,
    message: exception.message,
    severity: exception.severity,
    status: exception.status,
    value: exception.value,
  };
}

router.get("/me", async (req, res): Promise<void> => {
  const { member, organisation } = getOperationsContext(req);
  res.json(
    GetCurrentUserResponse.parse({
      id: member.clerkUserId,
      name: member.name,
      email: member.email,
      role: member.role,
      organisation: {
        id: organisation.id,
        name: organisation.name,
        code: organisation.code,
      },
    }),
  );
});

router.get("/dashboard", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [[exceptions], [runsThisMonth], [pendingActions], [completed], [successful], recentRuns] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(validationExceptionsTable)
        .where(
          and(
            eq(validationExceptionsTable.organisationId, organisation.id),
            eq(validationExceptionsTable.status, "open"),
          ),
        ),
      db
        .select({ value: count() })
        .from(runsTable)
        .where(
          and(
            eq(runsTable.organisationId, organisation.id),
            gte(runsTable.createdAt, monthStart),
          ),
        ),
      db
        .select({ value: count() })
        .from(actionRequestsTable)
        .where(
          and(
            eq(actionRequestsTable.organisationId, organisation.id),
            eq(actionRequestsTable.status, "requested"),
          ),
        ),
      db
        .select({ value: count() })
        .from(runsTable)
        .where(
          and(
            eq(runsTable.organisationId, organisation.id),
            sql`${runsTable.status} in ('succeeded', 'partial', 'failed')`,
          ),
        ),
      db
        .select({ value: count() })
        .from(runsTable)
        .where(
          and(
            eq(runsTable.organisationId, organisation.id),
            eq(runsTable.status, "succeeded"),
          ),
        ),
      db
        .select()
        .from(runsTable)
        .where(eq(runsTable.organisationId, organisation.id))
        .orderBy(desc(runsTable.createdAt))
        .limit(5),
    ]);

  const completedCount = Number(completed?.value ?? 0);
  const successRate =
    completedCount === 0
      ? 0
      : Math.round((Number(successful?.value ?? 0) / completedCount) * 100);

  res.json(
    GetDashboardResponse.parse({
      openExceptions: Number(exceptions?.value ?? 0),
      runsThisMonth: Number(runsThisMonth?.value ?? 0),
      pendingActions: Number(pendingActions?.value ?? 0),
      successRate,
      recentRuns: recentRuns.map(runView),
    }),
  );
});

router.get("/runs", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = ListRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const conditions = [eq(runsTable.organisationId, organisation.id)];
  if (parsed.data.status) conditions.push(eq(runsTable.status, parsed.data.status));
  const runs = await db
    .select()
    .from(runsTable)
    .where(and(...conditions))
    .orderBy(desc(runsTable.createdAt))
    .limit(parsed.data.limit);
  res.json(ListRunsResponse.parse(runs.map(runView)));
});

router.post(
  "/runs",
  requireRole("analyst", "administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const parsed = CreateRunBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const idempotencyKey = parsed.data.idempotencyKey ?? crypto.randomUUID();
    const [existing] = await db
      .select()
      .from(runsTable)
      .where(
        and(
          eq(runsTable.organisationId, organisation.id),
          eq(runsTable.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      res.status(201).json(CreateRunResponse.parse(runView(existing)));
      return;
    }
    const [run] = await db
      .insert(runsTable)
      .values({
        organisationId: organisation.id,
        createdByMemberId: member.id,
        fileName: parsed.data.fileName,
        fileType: parsed.data.fileType,
        fileSize: parsed.data.fileSize,
        objectPath: parsed.data.objectPath,
        idempotencyKey,
      })
      .returning();
    await db.insert(auditEventsTable).values({
      organisationId: organisation.id,
      action: "run.created",
      entityType: "run",
      entityId: run.id,
      actor: member.name,
      role: member.role,
      metadata: { fileName: run.fileName },
    });
    res.status(201).json(CreateRunResponse.parse(runView(run)));
  },
);

router.get("/runs/:runId", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = GetRunParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [run] = await db
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.id, parsed.data.runId),
        eq(runsTable.organisationId, organisation.id),
      ),
    )
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const [rows, attempts] = await Promise.all([
    db
      .select()
      .from(importRowsTable)
      .where(
        and(
          eq(importRowsTable.runId, run.id),
          eq(importRowsTable.organisationId, organisation.id),
        ),
      )
      .orderBy(importRowsTable.rowNumber),
    db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.entityId, run.id),
          eq(auditEventsTable.organisationId, organisation.id),
          inArray(auditEventsTable.action, ["run.processed", "run.failed"]),
        ),
      )
      .orderBy(desc(auditEventsTable.createdAt)),
  ]);
  const runAttempts = attempts.map((attempt) => {
    const metadata =
      attempt.metadata && typeof attempt.metadata === "object"
        ? (attempt.metadata as Record<string, unknown>)
        : {};
    return {
      id: attempt.id,
      actor: attempt.actor,
      startedAt:
        typeof metadata.startedAt === "string"
          ? metadata.startedAt
          : attempt.createdAt,
      durationMs:
        typeof metadata.durationMs === "number" ? metadata.durationMs : undefined,
      outcome:
        typeof metadata.status === "string"
          ? metadata.status
          : attempt.action === "run.failed"
            ? "failed"
            : "succeeded",
      reason: typeof metadata.reason === "string" ? metadata.reason : null,
    };
  });
  res.json(
    GetRunResponse.parse({
      ...runView(run),
      acceptedRows: rows.filter((row) => row.accepted),
      rejectedRows: rows.filter((row) => !row.accepted),
      attempts: runAttempts,
    }),
  );
});

router.post("/runs/:runId/process", async (req, res): Promise<void> => {
  const { member, organisation } = getOperationsContext(req);
  const parsed = ProcessRunParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [run] = await db
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.id, parsed.data.runId),
        eq(runsTable.organisationId, organisation.id),
      ),
    )
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (run.status !== "queued" && run.status !== "failed") {
    res.status(409).json({ error: "Run cannot be processed in its current state" });
    return;
  }
  const processed = await processRunForOrganisation(
    run.id,
    organisation.id,
    member,
  );
  res.status(202).json(ProcessRunResponse.parse(runView(processed ?? run)));
});

router.get("/runs/:runId/exceptions", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = ListRunExceptionsParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const exceptions = await db
    .select()
    .from(validationExceptionsTable)
    .where(
      and(
        eq(validationExceptionsTable.runId, parsed.data.runId),
        eq(validationExceptionsTable.organisationId, organisation.id),
      ),
    )
    .orderBy(validationExceptionsTable.rowNumber);
  res.json(ListRunExceptionsResponse.parse(exceptions.map(exceptionView)));
});

const llmSummarySchema = z.object({
  headline: z.string().min(1),
  overview: z.string().min(1),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  findings: z.array(
    z.object({
      title: z.string().min(1),
      detail: z.string().min(1),
      severity: z.enum(["low", "medium", "high", "critical"]),
    }),
  ),
});

router.get("/runs/:runId/summary", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = GetRunSummaryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [summary] = await db
    .select()
    .from(evidenceSummariesTable)
    .where(
      and(
        eq(evidenceSummariesTable.runId, parsed.data.runId),
        eq(evidenceSummariesTable.organisationId, organisation.id),
      ),
    )
    .limit(1);
  if (!summary) {
    res.status(404).json({ error: "Summary not found" });
    return;
  }
  res.json(GetRunSummaryResponse.parse(summary));
});

router.post("/runs/:runId/summary", async (req, res): Promise<void> => {
  const { member, organisation } = getOperationsContext(req);
  const params = GenerateRunSummaryParams.safeParse(req.params);
  const body = GenerateRunSummaryBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid summary request" });
    return;
  }
  const [run] = await db
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.id, params.data.runId),
        eq(runsTable.organisationId, organisation.id),
      ),
    )
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (run.status !== "succeeded" && run.status !== "partial") {
    res.status(409).json({ error: "Run is not ready for summarisation" });
    return;
  }
  const [existing] = await db
    .select()
    .from(evidenceSummariesTable)
    .where(eq(evidenceSummariesTable.runId, run.id))
    .limit(1);
  if (existing && !body.data.forceRegenerate) {
    res.status(201).json(GenerateRunSummaryResponse.parse(existing));
    return;
  }

  const exceptions = await db
    .select()
    .from(validationExceptionsTable)
    .where(
      and(
        eq(validationExceptionsTable.runId, run.id),
        eq(validationExceptionsTable.organisationId, organisation.id),
      ),
    );
  await db
    .update(runsTable)
    .set({ summaryStatus: "generating", updatedAt: new Date() })
    .where(eq(runsTable.id, run.id));

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.6-terra",
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an operations evidence analyst. Return only valid JSON with headline, overview, riskLevel, and findings. Each finding has title, detail, and severity. Ground every statement in the supplied exception records.",
        },
        {
          role: "user",
          content: JSON.stringify({
            fileName: run.fileName,
            recordCount: run.recordCount,
            exceptions: exceptions.map(exceptionView),
          }),
        },
      ],
    });
    const parsedSummary = llmSummarySchema.parse(
      JSON.parse(completion.choices[0]?.message.content ?? "{}"),
    );
    const [summary] = await db
      .insert(evidenceSummariesTable)
      .values({
        organisationId: organisation.id,
        runId: run.id,
        ...parsedSummary,
        model: "gpt-5.6-terra",
      })
      .onConflictDoUpdate({
        target: evidenceSummariesTable.runId,
        set: {
          ...parsedSummary,
          model: "gpt-5.6-terra",
          generatedAt: new Date(),
        },
      })
      .returning();
    await db
      .update(runsTable)
      .set({ summaryStatus: "ready", updatedAt: new Date() })
      .where(eq(runsTable.id, run.id));
    await db.insert(auditEventsTable).values({
      organisationId: organisation.id,
      action: "summary.generated",
      entityType: "summary",
      entityId: summary.id,
      actor: member.name,
      role: member.role,
      metadata: { runId: run.id, model: "gpt-5.6-terra" },
    });
    res.status(201).json(GenerateRunSummaryResponse.parse(summary));
  } catch (error) {
    await db
      .update(runsTable)
      .set({ summaryStatus: "failed", updatedAt: new Date() })
      .where(eq(runsTable.id, run.id));
    req.log.error({ err: error, runId: run.id }, "Evidence summary generation failed");
    res.status(500).json({ error: "Evidence summary generation failed" });
  }
});

router.get("/actions", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = ListActionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const conditions = [eq(actionRequestsTable.organisationId, organisation.id)];
  if (parsed.data.status) {
    conditions.push(eq(actionRequestsTable.status, parsed.data.status));
  }
  const actions = await db
    .select()
    .from(actionRequestsTable)
    .where(and(...conditions))
    .orderBy(desc(actionRequestsTable.requestedAt));
  res.json(ListActionsResponse.parse(actions.map(actionView)));
});

router.post(
  "/actions",
  requireRole("analyst", "administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const parsed = RequestActionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [ownedRun] = await db
      .select({ id: runsTable.id })
      .from(runsTable)
      .where(
        and(
          eq(runsTable.id, parsed.data.runId),
          eq(runsTable.organisationId, organisation.id),
        ),
      )
      .limit(1);
    if (!ownedRun) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const [action] = await db
      .insert(actionRequestsTable)
      .values({
        organisationId: organisation.id,
        runId: parsed.data.runId,
        actionType: parsed.data.actionType,
        title: parsed.data.title,
        rationale: parsed.data.rationale,
        requestedByMemberId: member.id,
      })
      .returning();
    await db.insert(auditEventsTable).values({
      organisationId: organisation.id,
      action: "action.requested",
      entityType: "action",
      entityId: action.id,
      actor: member.name,
      role: member.role,
      metadata: { actionType: action.actionType, runId: action.runId },
    });
    res.status(201).json(RequestActionResponse.parse(actionView(action)));
  },
);

router.post(
  "/actions/:actionId/approve",
  requireRole("administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const params = ApproveActionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [action] = await db
      .select()
      .from(actionRequestsTable)
      .where(
        and(
          eq(actionRequestsTable.id, params.data.actionId),
          eq(actionRequestsTable.organisationId, organisation.id),
        ),
      )
      .limit(1);
    if (!action) {
      res.status(404).json({ error: "Action not found" });
      return;
    }
    if (action.status !== "requested") {
      res.status(409).json({ error: "Action is no longer awaiting approval" });
      return;
    }
    await db
      .update(actionRequestsTable)
      .set({
        status: "running",
        decidedByMemberId: member.id,
        decidedAt: new Date(),
      })
      .where(eq(actionRequestsTable.id, action.id));
    const [completed] = await db
      .update(actionRequestsTable)
      .set({
        status: "completed",
        result: "Follow-up action executed and recorded for review.",
      })
      .where(eq(actionRequestsTable.id, action.id))
      .returning();
    await db.insert(auditEventsTable).values({
      organisationId: organisation.id,
      action: "action.approved_and_executed",
      entityType: "action",
      entityId: action.id,
      actor: member.name,
      role: member.role,
      metadata: { runId: action.runId },
    });
    res.json(ApproveActionResponse.parse(actionView(completed)));
  },
);

router.post(
  "/actions/:actionId/reject",
  requireRole("administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const params = RejectActionParams.safeParse(req.params);
    const body = RejectActionBody.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid action decision" });
      return;
    }
    const [rejected] = await db
      .update(actionRequestsTable)
      .set({
        status: "rejected",
        decidedByMemberId: member.id,
        decidedAt: new Date(),
        decisionNote: body.data.note ?? null,
      })
      .where(
        and(
          eq(actionRequestsTable.id, params.data.actionId),
          eq(actionRequestsTable.organisationId, organisation.id),
          eq(actionRequestsTable.status, "requested"),
        ),
      )
      .returning();
    if (!rejected) {
      res.status(404).json({ error: "Action not found or already decided" });
      return;
    }
    await db.insert(auditEventsTable).values({
      organisationId: organisation.id,
      action: "action.rejected",
      entityType: "action",
      entityId: rejected.id,
      actor: member.name,
      role: member.role,
      metadata: { note: body.data.note ?? null },
    });
    res.json(RejectActionResponse.parse(actionView(rejected)));
  },
);

router.get("/audit", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  const parsed = ListAuditEventsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const events = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.organisationId, organisation.id))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(parsed.data.limit);
  res.json(
    ListAuditEventsResponse.parse(
      events.map((event) => ({
        id: event.id,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        actor: event.actor,
        role: event.role,
        createdAt: event.createdAt,
        metadata: event.metadata ?? {},
      })),
    ),
  );
});

router.get("/settings", async (req, res): Promise<void> => {
  const { organisation } = getOperationsContext(req);
  res.json(
    GetSettingsResponse.parse({
      id: organisation.id,
      name: organisation.name,
      code: organisation.code,
      retentionDays: organisation.retentionDays,
      requireApproval: organisation.requireApproval,
    }),
  );
});

router.patch(
  "/settings",
  requireRole("administrator"),
  async (req, res): Promise<void> => {
    const { member, organisation } = getOperationsContext(req);
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [updated] = await db
      .update(organisationsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(organisationsTable.id, organisation.id))
      .returning();
    await db.insert(auditEventsTable).values({
      organisationId: organisation.id,
      action: "settings.updated",
      entityType: "organisation",
      entityId: organisation.id,
      actor: member.name,
      role: member.role,
      metadata: parsed.data,
    });
    res.json(
      UpdateSettingsResponse.parse({
        id: updated.id,
        name: updated.name,
        code: updated.code,
        retentionDays: updated.retentionDays,
        requireApproval: updated.requireApproval,
      }),
    );
  },
);

export default router;