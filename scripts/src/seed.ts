import { createClerkClient } from "@clerk/backend";
import { sql } from "drizzle-orm";
import { db, membersTable, organisationsTable, pool } from "@workspace/db";

const organisationCode = "NORTHSTAR-OPS";
const demoPassword =
  process.env.DEMO_USER_PASSWORD ?? "ProofOpsDemo!2026";

const demoUsers = [
  {
    email: "analyst@proofops.dev",
    firstName: "Avery",
    lastName: "Analyst",
    role: "analyst" as const,
  },
  {
    email: "administrator@proofops.dev",
    firstName: "Morgan",
    lastName: "Administrator",
    role: "administrator" as const,
  },
  {
    email: "auditor@proofops.dev",
    firstName: "Riley",
    lastName: "Auditor",
    role: "auditor" as const,
  },
];

async function ensureClerkUser(
  clerk: ReturnType<typeof createClerkClient>,
  user: (typeof demoUsers)[number],
) {
  const existing = await clerk.users.getUserList({
    emailAddress: [user.email],
    limit: 1,
  });
  if (existing.data[0]) return existing.data[0];

  return clerk.users.createUser({
    emailAddress: [user.email],
    password: demoPassword,
    firstName: user.firstName,
    lastName: user.lastName,
  });
}

async function seed() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "CLERK_SECRET_KEY is required so the seed can create sign-in accounts.",
    );
  }
  const clerk = createClerkClient({ secretKey });

  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION operations_reject_audit_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'operations_audit_events is append-only';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS operations_audit_events_append_only
      ON operations_audit_events;
    CREATE TRIGGER operations_audit_events_append_only
      BEFORE UPDATE OR DELETE ON operations_audit_events
      FOR EACH ROW EXECUTE FUNCTION operations_reject_audit_mutation();
  `));

  const [organisation] = await db
    .insert(organisationsTable)
    .values({
      name: "Northstar Operations",
      code: organisationCode,
      retentionDays: 365,
      requireApproval: true,
    })
    .onConflictDoUpdate({
      target: organisationsTable.code,
      set: {
        name: "Northstar Operations",
        updatedAt: new Date(),
      },
    })
    .returning();

  for (const user of demoUsers) {
    const clerkUser = await ensureClerkUser(clerk, user);
    await db
      .insert(membersTable)
      .values({
        organisationId: organisation.id,
        clerkUserId: clerkUser.id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        role: user.role,
      })
      .onConflictDoUpdate({
        target: membersTable.clerkUserId,
        set: {
          organisationId: organisation.id,
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
        },
      });
  }

  console.log(`Seeded organisation: ${organisation.name}`);
  for (const user of demoUsers) {
    console.log(`- ${user.role}: ${user.email}`);
  }
  console.log(
    process.env.DEMO_USER_PASSWORD
      ? "Demo users use the password supplied in DEMO_USER_PASSWORD."
      : `Demo password: ${demoPassword}`,
  );
}

seed()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });