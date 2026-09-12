# Entry points

All API endpoints below are mounted under `/api`.

## Frontend routes

Declared in `artifacts/operations-evidence-console/src/App.tsx`.

| Route | Purpose |
|---|---|
| `/` | Public landing page |
| `/sign-in` | Clerk sign-in |
| `/sign-up` | Clerk registration |
| `/dashboard` | Organisation overview |
| `/runs` | Import history |
| `/runs/new` | Direct-to-storage upload flow |
| `/runs/:runId/exceptions` | Run detail, rows, attempts, and validation exceptions |
| `/runs/:runId/summary` | Evidence summary and action request |
| `/actions/queue` | Administrator approval queue |
| `/audit` | Read-only audit trail |
| `/settings` | Organisation settings |

Each routed screen is wrapped in an independent recovery boundary.

## API bootstrap and route mounts

- `artifacts/api-server/src/index.ts` installs audit guards, starts Express, and starts the scheduler.
- `artifacts/api-server/src/app.ts` captures raw JSON bytes, installs Clerk middleware, and mounts `/api`.
- `artifacts/api-server/src/routes/index.ts` mounts health, integration, operations, and storage routers.

## API endpoints

| Method and path | Purpose |
|---|---|
| `GET /healthz` | Health check |
| `GET /me` | Current member, role, and organisation |
| `GET /dashboard` | Organisation metrics and recent runs |
| `GET /runs` | List tenant-scoped runs |
| `POST /runs` | Create an idempotent queued run |
| `GET /runs/:runId` | Run detail, accepted/rejected rows, and attempts |
| `POST /runs/:runId/process` | Claim or rerun processing |
| `GET /runs/:runId/exceptions` | Validation exceptions |
| `GET /runs/:runId/summary` | Stored evidence summary |
| `POST /runs/:runId/summary` | Generate or regenerate a summary |
| `GET /actions` | List action requests |
| `POST /actions` | Request an allowlisted action |
| `POST /actions/:actionId/approve` | Approve and execute a typed durable effect |
| `POST /actions/:actionId/reject` | Reject an action with a reason |
| `GET /audit` | Read audit and inbound-refusal events |
| `GET /settings` | Read organisation settings |
| `PATCH /settings` | Update settings as an administrator |

## Upload handlers

- `POST /storage/uploads/request-url` in `artifacts/api-server/src/routes/storage.ts` authenticates the caller, requires analyst/administrator role, validates metadata, and returns a presigned URL plus object path.
- `NewRunPage` in `artifacts/operations-evidence-console/src/App.tsx` validates file type, size, and bounded content before sending a direct `PUT` to the presigned URL.
- `POST /runs` records the uploaded object as a queued run.
- `artifacts/api-server/src/lib/processing.ts` downloads bytes, computes the content hash, validates rows, deduplicates imports, and persists rows/exceptions/audit evidence.
- `GET /storage/objects/*path` serves tenant-owned private objects.
- `GET /storage/public-objects/*filePath` serves explicitly public search paths without authentication.

## Scheduled and internal jobs

- `startProcessingScheduler` in `artifacts/api-server/src/lib/processingScheduler.ts` runs after API startup.
- Each sweep processes queued/stuck runs and accepted inbound deliveries per organisation.
- The default interval is 60 seconds, with a minimum configurable interval of 10 seconds.
- Work is capped at 10 runs/deliveries per organisation per sweep and a four-minute processing timeout.
- `POST /jobs/process-imports` provides a token-protected manual/internal processing entry point.

## Inbound events

- `POST /webhooks/inbound` in `artifacts/api-server/src/routes/integrations.ts`.
- Required headers carry source, delivery ID, Unix timestamp, and HMAC-SHA256 signature.
- The signature input is `timestamp.source.exactRawBody`.
- Events outside the five-minute window are refused.
- The `(source, external event ID)` pair prevents exact replay.
- Accepted delivery and audit rows commit together before the API returns `202`.
- `artifacts/api-server/src/lib/inboundProcessing.ts` applies accepted deliveries asynchronously and through scheduler retries.

## Model call sites

- `POST /runs/:runId/summary` assembles tenant-owned rows and exceptions in `artifacts/api-server/src/routes/operations.ts`.
- `generateStructuredSummary` in `artifacts/api-server/src/lib/summaryService.ts` is the only evidence-summary model call path.
- The service calls the Replit-managed OpenAI client with `gpt-5.6-terra`, a 15-second timeout, SDK retries disabled, and no more than three application attempts.
- `artifacts/api-server/src/lib/summaryPolicy.ts` validates strict output shape and source-row citations before storage.
