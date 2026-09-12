# Known limitations

- **External services are not exercised by `pnpm test`.** The deterministic suite tests production policies and model retry logic with injected seams, but it does not perform a live Clerk sign-in, presigned Object Storage upload, or provider model request.
- **Seeded object paths are illustrative.** Seeded runs point to `sample-data/fixtures` paths in database metadata; the fixture bytes are not uploaded into Object Storage. Inspect the seeded results, but do not expect a seeded run to be reprocessed unless its object is uploaded.
- **Reset is destructive.** `pnpm reset` deletes every Operations Evidence Console record in the selected database before reseeding. It is intended for development/demo databases only.
- **Processing is asynchronous.** The scheduler polls rather than guaranteeing immediate completion. A sweep handles at most 10 runs and 10 inbound deliveries per organisation and applies a four-minute timeout.
- **Uploads are bounded.** CSV and JSON files are limited to 250 MB. Browser validation samples large files; complete parsing and schema validation happen on the server.
- **Summaries depend on an external model provider.** Requests can end in explicit timeout, rate-limit, or malformed-output states after three attempts. Generation is not guaranteed.
- **The action catalogue is intentionally small.** Only source correction, owner notification, and review-task creation are supported. Unknown or model-proposed action types are refused.
- **Public object paths are public by design.** Anything under `PUBLIC_OBJECT_SEARCH_PATHS` can be read without authentication. Operational uploads must remain under the private object directory.
- **Private object access is organisation-based.** The current product verifies that the requested object path belongs to a run or import in the caller's organisation. Generic object-level sharing groups are not implemented.
- **Clerk development keys have provider limits.** Development instances are suitable for local use but must be replaced with production configuration before publishing for real users.
- **Weakness branches are intentionally unsafe.** They are training variants, not supported product configurations, and must never be merged into or deployed over the safe release.
