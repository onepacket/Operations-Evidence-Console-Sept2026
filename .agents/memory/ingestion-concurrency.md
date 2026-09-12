---
name: Ingestion concurrency
description: Non-obvious concurrency guarantees required for safe retries and idempotent import processing.
---

Import attempts must fence terminal writes against the exact claim that started them. Content-hash and submission idempotency decisions must be serialized transactionally, and all scheduled I/O must have real cancellation plus finite network and database timeouts.

**Why:** A timed-out worker can continue after another worker reclaims its run. Without fencing it can overwrite the newer result; without serialization concurrent workers can create duplicate canonical rows; without cancellation hung work can exhaust resources and stop later sweeps.

**How to apply:** Any processing or scheduler change must preserve claim ownership checks on success and failure, atomic failure-reason recording, organisation-scoped content serialization, exhausted-attempt finalization, raw-byte hashing, and abort propagation through storage operations.