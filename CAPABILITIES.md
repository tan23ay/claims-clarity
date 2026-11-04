# Capability ledger

This ledger keeps the demo honest about what is implemented in the prototype and what remains a mock or future integration.

| Capability | Status | Notes |
| --- | --- | --- |
| 50-record synthetic claims dataset | IMPLEMENTED | Deterministic seed in `scripts/generate-data.mjs`; provenance is `SYNTHETIC`. |
| Claims search and filters | IMPLEMENTED | Exact record display with outcome and risk filters. |
| Evidence packet display | IMPLEMENTED | Claim facts, reason status, policy support, as-of time, and next steps. |
| Versioned policy citation view | IMPLEMENTED | Demo document, section, page, effective date, quote, and content hash. |
| Deterministic escalation floor | IMPLEMENTED | Server recomputes evidence checks and review requirements; candidate JEV risk never lowers the floor. |
| Guided voice workflow | PARTIAL | Browser simulation with verification checkbox, exact claim reference, scripted explanation, and handoff preparation. |
| Speech synthesis | PARTIAL | Uses the local browser `speechSynthesis` API when available. |
| Identity verification | MOCKED | Checkbox only; no identity provider or step-up verification. |
| Claims system integration | MOCKED | Static JSON extract; no live insurer system. |
| Policy ingestion and retrieval | MOCKED | Pre-seeded citations; no document processing or vector search. |
| JEV shadow adapter | IMPLEMENTED | Direct TypeSafe contract, full probabilities, confidence/margin gates, timeout and circuit fallback. Disabled by default; vendor live validation requires a valid TypeSafe key. |
| JEV operational routing | UNAVAILABLE | Shadow results do not alter operational decisions; no held-out value-gate evaluation has been conducted. |
| Telephony / streaming voice | UNAVAILABLE | No telephony provider or audio transport is connected. |
| Appeal submission or claim modification | UNAVAILABLE | Intentionally outside the prototype boundary. |
| Audit persistence | IMPLEMENTED | SQLite events with an append-only SQL trigger and SHA-256 chain; admin integrity check. No external hash anchoring. |
| Operator sessions | IMPLEMENTED | Opaque bearer/cookie sessions, expiration, logout, CSRF, demo/admin roles, scrypt password hashing. |
| Caller identity verification | MOCKED | Synthetic checkbox enforced separately by the server state machine. |
| Call and handoff authorization | IMPLEMENTED | Ownership checked against the session on every call operation; input cannot override identity. |
| Guided-call backend | IMPLEMENTED | Persisted verification, exact lookup, scripted evidence explanation, cancellation/completion and idempotent handoff preparation. |
| Docker database persistence | IMPLEMENTED | Named SQLite volume; dataset/migrations packaged in non-root image. Engine must be available to run it. |
| REST API and OpenAPI | IMPLEMENTED | Claims, policies, stats, sessions, calls, JEV shadow, audit and admin endpoints. |
| GitHub CI | IMPLEMENTED | Dataset/API tests, OpenAPI regeneration check, Docker build and container smoke test. |
| Production privacy/security controls | UNAVAILABLE | Do not use real PHI; no HIPAA or production-readiness claim is made. |
