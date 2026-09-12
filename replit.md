# Operations Evidence Console

Production-shaped evidence intake, validation, summary, approval, and audit workflows for operations teams.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm test` — run the complete automated unit and operations workflow regression suite
- `pnpm seed` — create the demo users and clean, malformed, and duplicate sample runs
- `pnpm reset` — delete Operations Evidence Console data and restore the deterministic seeded state
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

The automated suite covers the governed happy path, access isolation, signed inbound events, ingestion and reruns, and model output/failure handling. It uses deterministic production helpers and does not call Clerk, object storage, or the live model.

## Where things live

- `artifacts/operations-evidence-console` — React/Vite console
- `artifacts/api-server` — Express API and automated tests
- `lib/db/src/schema/operations.ts` — Operations database schema
- `lib/api-spec/openapi.yaml` — API contract
- `scripts/src/seed.ts` — deterministic seed and reset commands
- `sample-data/fixtures` — clean, malformed, and duplicate sample files

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
