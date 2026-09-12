import { sql } from "drizzle-orm";

import { db } from "@workspace/db";

export async function ensureOperationalAuditGuards(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION operations_reject_audit_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'operations audit ledgers are append-only';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS operations_audit_events_append_only
      ON operations_audit_events;
    CREATE TRIGGER operations_audit_events_append_only
      BEFORE UPDATE OR DELETE ON operations_audit_events
      FOR EACH ROW EXECUTE FUNCTION operations_reject_audit_mutation();
    DROP TRIGGER IF EXISTS operations_audit_events_no_truncate
      ON operations_audit_events;
    CREATE TRIGGER operations_audit_events_no_truncate
      BEFORE TRUNCATE ON operations_audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION operations_reject_audit_mutation();

    DROP TRIGGER IF EXISTS operations_inbound_refusal_audit_append_only
      ON operations_inbound_refusal_audit;
    CREATE TRIGGER operations_inbound_refusal_audit_append_only
      BEFORE UPDATE OR DELETE ON operations_inbound_refusal_audit
      FOR EACH ROW EXECUTE FUNCTION operations_reject_audit_mutation();
    DROP TRIGGER IF EXISTS operations_inbound_refusal_audit_no_truncate
      ON operations_inbound_refusal_audit;
    CREATE TRIGGER operations_inbound_refusal_audit_no_truncate
      BEFORE TRUNCATE ON operations_inbound_refusal_audit
      FOR EACH STATEMENT EXECUTE FUNCTION operations_reject_audit_mutation();
  `));
}