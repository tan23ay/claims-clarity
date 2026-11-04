# Backend architecture and decisions

## Scope

The API serves the same 50 synthetic fixtures as the existing frontend. It explains stored adjudication outcomes and prepares human handoffs. Data remains a single demonstration workspace; each operator owns their own calls, sessions, and handoffs. This is a deliberately bounded implementation of the original product reference, whose proposed production stack and wider roadmap are not claimed here.

```text
Browser / curl
  -> Node HTTP boundary (origin checks, body limit, rate limits, request ID)
  -> session authentication + owner authorization
  -> call state machine and deterministic evidence engine
  -> SQLite (fixtures, policies, sessions, calls, handoffs, audit, JEV decisions)
  -> optional TypeSafe JEV shadow adapter (enumerated synthetic facts only)
```

## ADR-001: Node.js 24 and SQLite

Keep the existing JavaScript frontend and use Node.js 24.15+ with built-in HTTP, crypto, test runner, and SQLite. The app has no external package dependencies. This substitutes for the reference document's FastAPI/PostgreSQL stack for the synthetic prototype. SQLite migrations, transactions, foreign keys, a WAL journal, and prepared statements make the demo portable; the database volume survives container restarts. SQLite is suitable for this small single-service dataset. A production/multi-tenant implementation needs a separate design and PostgreSQL row-level security. Node's SQLite API is documented at <https://nodejs.org/docs/latest-v24.x/api/sqlite.html>.

## ADR-002: Server authority and demo identity

An unauthenticated visitor may fetch the UI, health, metadata, and API schema. Claims and workflow APIs require an operator session. Demo mode creates a fresh operator identity, and an optional configured administrator password is hashed with scrypt. Session tokens are random opaque values stored as hashes. Cookie sessions use HttpOnly/SameSite=Lax and a per-session CSRF token for mutations. API clients may use bearer tokens. User/role values supplied by callers are rejected. Calls and handoffs always resolve by both record ID and session user ID.

This authenticates a demo operator, not a health-plan member. The separate `DEMO_CONFIRMED` checkbox is simulated caller verification. All demo operators may read all synthetic fixture claims; this is not a member-access grants system. `APP_ENV=production` is refused.

## ADR-003: Stored evidence and workflow

Migrations create users, sessions, policies, claims, calls, handoffs, JEV evaluations, and audit events. Fixture import occurs only when the claim table is empty. Evidence checks bind the synthetic passage to its plan, version, service date, quote, and computed SHA-256 content hash. Missing/partial support is qualified, and unsupported policy text is excluded from the spoken explanation. Pending claims get a status-only response. Amounts are converted to integer cents for aggregate reconciliation. Existing fixture confidence values are synthetic metadata, not JEV predictions.

Allowed call transitions:

```text
CREATED -> VERIFIED -> MATCHED -> INVESTIGATING -> EXPLAINED
EXPLAINED -> ESCALATED (handoff) -> COMPLETED
EXPLAINED -> COMPLETED
Any active state before ESCALATED -> CANCELLED
```

Explanation retries return the saved result. Handoffs have a unique `call_id`, so retries return the same prepared packet. Version checks reject concurrent state changes. An interrupted investigation is reset to MATCHED on service restart so it can be requested again; no external action is replayed. No paid/denied outcome can be changed via the API.

## JEV adapter

ADR-004, verified 2026-10-13 against <https://docs.typesafe.ai/api>, <https://docs.typesafe.ai/models>, and <https://docs.typesafe.ai/confidence>.

Direct endpoint: `POST https://api.typesafe.ai/v1/systemone`. Authentication: TypeSafe-issued bearer key. Default pinned model: `jev-1.13.0`. The adapter deliberately has a fixed HTTPS endpoint and refuses redirects; it cannot forward the key to a caller-selected URL. An OpenRouter key is rejected when enabling this direct integration.

Catalog `claims-risk-shadow-v1` asks a Choice risk question (LOW/MEDIUM/HIGH) and a Noul human-review question. The input contains allowlisted administrative enums and a synthetic marker, with no claim/member identifier, names, dates, passage, transcript, or user instructions. The strict response contract validates model version, probability ranges/sum, chosen class, confidence, Noul, and token counts. Returned probabilities are preserved, not collapsed into a boolean.

Candidate risk = max(deterministic floor, accepted JEV risk). Acceptance requires confidence >= 0.8 and leading probability margin >= 0.2 by default. Noul >= 0.8 suggests human review; values between 0.2 and 0.8 are marked uncertain. These are demonstration thresholds, not evaluated healthcare thresholds. The response exposes both the candidate and the unchanged operational route. The backend stores model version, catalog version, request hash, latency, thresholds, outcome, and fallback reason. Timeout defaults to 2500 ms; provider output is capped at 64 KiB. Three consecutive failures open a 30-second circuit. The adapter performs no automatic retries.

JEV is feature-flagged and disabled until configured. A live request is not included in automated tests; those inject an HTTP stub. A valid TypeSafe key and a separate held-out evaluation are needed before claiming the integration improves routing or enabling non-shadow behavior.

## ADR-005: Audit and operations

Audit writes are generated by server actions and cannot be edited/deleted through the API. SQLite triggers reject UPDATE/DELETE on audit rows. SHA-256 hashes chain each entry to its predecessor; the administrator can verify the complete chain. This detects modifications in an unchanged database schema, but a database administrator could rewrite triggers and hashes: the chain has no external trust anchor. Routine logs contain method, HTTP status, timing, and request ID, with no body, query string, credential or raw record text.

Docker runs as `node`, preserves the SQLite volume, and checks `/api/health`. A reverse proxy must supply HTTPS for remote deployments; enable secure cookies there. Only one service instance should write a given SQLite database. PostgreSQL, distributed sessions/rate limits, backup scheduling, external audit anchoring and tenant grants require further production work.
