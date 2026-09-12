---
name: Webhook audit trust
description: Tenant audit attribution rules for signed inbound-event refusals.
---

Webhook refusal evidence must retain the organisation ID claimed by the sender separately from a verified organisation association. Only a valid HMAC may promote a claimed organisation into tenant-visible audit history.

**Why:** Invalid-signature callers control the request body. Treating its organisation ID as authoritative lets attackers inject records into another tenant’s audit trail.

**How to apply:** Record all refusals in the system ledger, verify the signature before freshness and tenant attribution, and filter organisation audit views using only the verified association.