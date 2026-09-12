---
name: Evidence summary trust
description: Safety constraints for generated operational evidence summaries.
---

Generated summaries should receive only structured ingested records and system validation exceptions. Their schema must require source-row citations for every claim, and invalid or uncited output must never be stored.

**Why:** A summary without traceable evidence or with user-entered instructions mixed into its prompt cannot support an auditable operational decision.

**How to apply:** Keep the prompt input allowlist narrow, validate citations against the rows supplied to the model, store model and prompt versions, and expose bounded timeout, rate-limit, and malformed-output retries as distinct states.