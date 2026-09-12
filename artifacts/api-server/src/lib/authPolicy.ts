export type OperationsRole = "analyst" | "administrator" | "auditor";

export function hasOperationsRole(
  role: OperationsRole | undefined,
  allowedRoles: readonly OperationsRole[],
): boolean {
  return role !== undefined && allowedRoles.includes(role);
}

export function isAuthenticated(
  userId: string | null | undefined,
): userId is string {
  return typeof userId === "string" && userId.length > 0;
}

export function isSameOrganisation(
  memberOrganisationId: string,
  targetOrganisationId: string,
): boolean {
  return memberOrganisationId === targetOrganisationId;
}

/**
 * Audit ledgers are append-only. There is intentionally no role that can
 * mutate an existing audit event, including administrators and auditors.
 */
export function canMutateAuditLedger(_role: OperationsRole | undefined): false {
  return false;
}