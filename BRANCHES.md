# Weakness branches

Safe reference: `main`.

Every `weak/*` branch must contain exactly one commit on top of `main`, remove
only the named safeguard, and remain unmerged and undeployed.

Git commit IDs include their parent commit. Because these weakness commits are
descendants of `main`, their final literal SHAs cannot be embedded in a commit
on `main` without changing `main` and therefore changing every descendant SHA.
The authoritative SHA command for each branch is listed below. It resolves to
the exact current commit without making this document stale.

| Branch | Exact commit SHA | File and function | Safeguard removed | Expected outcome |
|---|---|---|---|---|
| `weak/frontend-no-error-containment` | `git rev-parse weak/frontend-no-error-containment` | `artifacts/operations-evidence-console/src/App.tsx` — `DashboardRoute` | Dashboard screen error boundary | The dashboard boundary regression test fails because a render exception escapes the screen boundary. |
| `weak/api-no-auth` | `git rev-parse weak/api-no-auth` | `artifacts/api-server/src/routes/integrations.ts` — `POST /jobs/process-imports` handler | Internal job-token check | The HTTP integration test receives a successful processing response instead of `401`. |
| `weak/api-no-tenant-scope` | `git rev-parse weak/api-no-tenant-scope` | `artifacts/api-server/src/routes/operations.ts` — `GET /runs/:runId` handler | Organisation predicate on the run lookup | The cross-organisation HTTP test receives another tenant's run instead of `404`. |
| `weak/webhook-no-verification` | `git rev-parse weak/webhook-no-verification` | `artifacts/api-server/src/routes/integrations.ts` — `POST /webhooks/inbound` handler | HMAC signature verification | The forged-signature HTTP test accepts and stores the event instead of returning `401`. |
| `weak/webhook-no-replay-guard` | `git rev-parse weak/webhook-no-replay-guard` | `artifacts/api-server/src/routes/integrations.ts` — `POST /webhooks/inbound` handler | Deterministic delivery replay key | The replay HTTP test accepts the same signed event twice and stores two deliveries. |
| `weak/pipeline-no-schema` | `git rev-parse weak/pipeline-no-schema` | `artifacts/api-server/src/lib/processing.ts` — `processRunForOrganisation` | Row schema exception generation | The full processor marks malformed rows accepted instead of persisting validation exceptions. |
| `weak/pipeline-non-idempotent` | `git rev-parse weak/pipeline-non-idempotent` | `artifacts/api-server/src/lib/processing.ts` — `processRunForOrganisation` | Stable content-hash idempotency | Byte-identical runs create separate imports and duplicate accepted rows. |
| `weak/llm-no-output-schema` | `git rev-parse weak/llm-no-output-schema` | `artifacts/api-server/src/lib/summaryService.ts` — `generateStructuredSummary` | Generated-output schema and citation validation | Schema-invalid but syntactically valid JSON is returned instead of rejected after three attempts. |
| `weak/llm-unbounded` | `git rev-parse weak/llm-unbounded` | `artifacts/api-server/src/lib/summaryService.ts` — `generateStructuredSummary` | Explicit request timeout and retry ceiling | Retry regression tests fail at their explicit deadline instead of hanging the suite. |
| `weak/agent-open-tools` | `git rev-parse weak/agent-open-tools` | `artifacts/api-server/src/routes/operations.ts` — `POST /actions/:actionId/approve` handler | Administrator approval role middleware | Analyst/auditor HTTP approval attempts are no longer consistently rejected with `403`. |

Verify branch shape without checking out a weakness branch:

```bash
git rev-list --count main..weak/api-no-auth
git diff --name-only main...weak/api-no-auth
git branch --merged main
```

The first command must print `1`, the second must print one changed file, and
the merged-branch list must not contain any `weak/*` branch.