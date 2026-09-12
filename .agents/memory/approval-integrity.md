---
name: Approval integrity
description: Durable safety rules for governed follow-up actions and their audit evidence.
---

An action decision, its recorded reason, its typed durable effect, and the corresponding audit entry must commit atomically. A requester cannot decide their own request, and every execution path must use the same explicit action allowlist.

**Why:** A status change that claims execution without a durable effect, or a business mutation that commits without its audit record, breaks the evidence chain and can bypass meaningful approval.

**How to apply:** Transition through approval before creating the effect, serialize competing decisions, keep auditors read-only at both API and UI layers, and block update, delete, and truncate on every audit ledger.