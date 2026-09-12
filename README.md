# Operations Evidence Console

A production-shaped console for importing operational evidence, reviewing validation exceptions, generating cited summaries, governing follow-up actions, and inspecting an append-only audit trail.

## Stack

- **Web:** React, Vite, TypeScript, Wouter, TanStack Query, Clerk
- **API:** Express 5, TypeScript, Zod/OpenAPI-generated validators
- **Data:** PostgreSQL, Drizzle ORM
- **Files:** Replit Object Storage with direct-to-storage uploads
- **AI:** Replit-managed OpenAI integration
- **Workspace:** pnpm monorepo

See [docs/architecture.md](docs/architecture.md) for the system flow and trust boundaries.

## Prerequisites

- Node.js 24
- pnpm through Corepack
- PostgreSQL through `DATABASE_URL`
- A Clerk development or production instance
- Replit Object Storage configuration
- Replit-managed OpenAI integration credentials

Copy `.env.example` into the environment configuration and supply values through Replit Secrets or your local secret manager. Never commit credentials.

## Install

```bash
corepack enable
pnpm install
pnpm --filter @workspace/db run push
```

The schema push command is for development environments. Use an approved migration process for production.

## Seed

```bash
pnpm seed
```

The seed creates or updates analyst, administrator, and auditor demo accounts, then creates deterministic clean, malformed, and duplicate sample runs from `sample-data/fixtures`.

`CLERK_SECRET_KEY` is required. `DEMO_USER_PASSWORD` is required only when a demo Clerk user does not already exist. The command never prints the password.

## Run

Replit runs the API and web artifact through the configured workflows. For direct workspace use:

```bash
# Terminal 1
PORT=8080 pnpm --filter @workspace/api-server run dev

# Terminal 2
PORT=5173 BASE_PATH=/operations-evidence-console \
  pnpm --filter @workspace/operations-evidence-console run dev
```

The API binds to `PORT`. The frontend uses `BASE_PATH` because Replit serves artifacts through path-based routing.

## Test

Run the complete regression suite with one command:

```bash
pnpm test
```

The suite covers the governed happy path, real HTTP route middleware, an isolated
temporary PostgreSQL schema, signed inbound events, full ingestion and
deduplication, screen error containment, and model output/failure handling. It
does not call live Clerk, Object Storage, or model services; those boundaries use
explicit test-only seams. See [known limitations](docs/known-limitations.md).

Additional release checks:

```bash
pnpm run typecheck
pnpm run build
```

## Reset

```bash
pnpm reset
```

**Warning:** this deletes all Operations Evidence Console records in the selected database, reinstalls the append-only audit guards, and reseeds the deterministic demo state. It preserves Clerk users. Do not use it as a production maintenance command.

## Entry points

See [docs/entry-points.md](docs/entry-points.md) for frontend routes, API endpoints, upload handlers, scheduled jobs, inbound events, and model call sites.

## Weakness branches

Weakness branches are intentionally unsafe training variants. Never merge or deploy them. Each starts from the safe release and changes one behavior only.

Fetch refs, then check out a branch:

```bash
git fetch --all --prune
git switch weak/frontend-no-error-containment
```

Available branch names and checkout commands:

| Weakness | Checkout command |
|---|---|
| Frontend screen without error containment | `git switch weak/frontend-no-error-containment` |
| Protected API route without authentication | `git switch weak/api-no-auth` |
| Server query without tenant scope | `git switch weak/api-no-tenant-scope` |
| Inbound webhook without signature verification | `git switch weak/webhook-no-verification` |
| Inbound webhook without replay protection | `git switch weak/webhook-no-replay-guard` |
| Ingestion without declared row validation | `git switch weak/pipeline-no-schema` |
| Ingestion without content idempotency | `git switch weak/pipeline-non-idempotent` |
| Model output without schema validation | `git switch weak/llm-no-output-schema` |
| Model call without timeout/retry bounds | `git switch weak/llm-unbounded` |
| Consequential action without its governance gate | `git switch weak/agent-open-tools` |

If Git reports that a branch is unknown, that weakness exercise has not been created in the repository yet. Return to the safe release with:

```bash
git switch main
```

## Further documentation

- [Architecture](docs/architecture.md)
- [Entry points](docs/entry-points.md)
- [Known limitations](docs/known-limitations.md)
