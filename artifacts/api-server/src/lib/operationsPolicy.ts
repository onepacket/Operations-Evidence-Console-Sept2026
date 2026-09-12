export const allowedActionTypes = [
  "request_correction",
  "notify_owner",
  "create_review_task",
] as const;

export type AllowedActionType = (typeof allowedActionTypes)[number];
export type ActionViewerRole = "analyst" | "administrator" | "auditor";
export type ActionStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "running"
  | "completed"
  | "failed";

const allowedActionTypeSet = new Set<string>(allowedActionTypes);

export function isAllowedActionType(value: string): value is AllowedActionType {
  return allowedActionTypeSet.has(value);
}

export function actionEffect(actionType: AllowedActionType, runId: string) {
  if (actionType === "request_correction") {
    return { kind: "correction_work_item", runId, status: "open" };
  }
  if (actionType === "notify_owner") {
    return { kind: "owner_notification", runId, status: "queued" };
  }
  return { kind: "review_task", runId, status: "open" };
}

export function actionResult(actionType: AllowedActionType): string {
  if (actionType === "request_correction") {
    return "A source correction work item was created.";
  }
  if (actionType === "notify_owner") {
    return "A data owner notification was queued for delivery.";
  }
  return "A review task was created.";
}

export function canDecideAction(input: {
  viewerRole: ActionViewerRole | undefined;
  actionStatus: ActionStatus;
  requestedByMemberId: string;
  viewerId: string | undefined;
}): boolean {
  return input.viewerRole === "administrator" &&
    input.actionStatus === "requested" &&
    input.viewerId !== undefined &&
    input.requestedByMemberId !== input.viewerId;
}

export function canAccessOrganisation(
  memberOrganisationId: string,
  resourceOrganisationId: string,
): boolean {
  return memberOrganisationId === resourceOrganisationId;
}