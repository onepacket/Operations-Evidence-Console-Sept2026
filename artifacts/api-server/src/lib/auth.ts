import { createHash } from "node:crypto";
import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";

import {
  db,
  auditEventsTable,
  membersTable,
  organisationsTable,
  type Member,
  type Organisation,
} from "@workspace/db";
import {
  hasOperationsRole,
  isAuthenticated,
} from "./authPolicy";

export type OperationsContext = {
  member: Member;
  organisation: Organisation;
};

export type AuthenticatedRequest = Request & {
  operationsContext?: OperationsContext;
};

export async function requireOperationsAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    process.env.NODE_ENV === "test" &&
    (req as AuthenticatedRequest).operationsContext
  ) {
    next();
    return;
  }
  const auth = getAuth(req);
  const userId = auth.userId;

  if (!isAuthenticated(userId)) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const [context] = await db
    .select({ member: membersTable, organisation: organisationsTable })
    .from(membersTable)
    .innerJoin(
      organisationsTable,
      eq(membersTable.organisationId, organisationsTable.id),
    )
    .where(eq(membersTable.clerkUserId, userId))
    .limit(1);

  if (!context) {
    res
      .status(403)
      .json({ error: "Your account is not provisioned for an organisation" });
    return;
  }

  (req as AuthenticatedRequest).operationsContext = context;
  if (auth.sessionId) {
    const authSessionKey = createHash("sha256")
      .update(auth.sessionId)
      .digest("hex");
    await db
      .insert(auditEventsTable)
      .values({
        organisationId: context.organisation.id,
        action: "auth.signed_in",
        entityType: "session",
        entityId: authSessionKey,
        actor: context.member.name,
        role: context.member.role,
        authSessionKey,
      })
      .onConflictDoNothing({
        target: [
          auditEventsTable.organisationId,
          auditEventsTable.action,
          auditEventsTable.authSessionKey,
        ],
      });
  }
  next();
}

export function requireRole(
  ...roles: Array<Member["role"]>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const context = (req as AuthenticatedRequest).operationsContext;
    if (!context || !hasOperationsRole(context.member.role, roles)) {
      res.status(403).json({ error: "This role cannot perform that action" });
      return;
    }
    next();
  };
}

export function getOperationsContext(req: Request): OperationsContext {
  const context = (req as AuthenticatedRequest).operationsContext;
  if (!context) {
    throw new Error("Operations context missing");
  }
  return context;
}

export function organisationFilter(req: Request) {
  return and(
    eq(
      membersTable.organisationId,
      getOperationsContext(req).organisation.id,
    ),
  );
}