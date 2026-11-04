# API walkthrough

Base URL: `http://127.0.0.1:4173`. All example records are synthetic. Requests return JSON; failures have `{ "error": { "code", "message", "requestId" } }`. API detail is in [openapi.json](openapi.json), served at `/api/openapi.json`.

## Complete demo workflow

1. Start a session:

```bash
curl -X POST http://127.0.0.1:4173/api/auth/demo \
  -H 'Content-Type: application/json' -d '{}'
```

Copy the returned `token` into the `TOKEN` placeholder below. Do not commit or share session tokens. The browser uses the HttpOnly cookie and returned CSRF token automatically; curl can use the bearer token.

2. Inspect the dataset:

```bash
curl http://127.0.0.1:4173/api/claims?limit=100 -H 'Authorization: Bearer TOKEN'
curl http://127.0.0.1:4173/api/claims/CLM-PA-02600/evidence -H 'Authorization: Bearer TOKEN'
```

3. Create a call and copy its returned `id` into `CALL_ID`:

```bash
curl -X POST http://127.0.0.1:4173/api/calls \
  -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' -d '{}'
```

4. Confirm the simulated caller, then perform exact claim matching:

```bash
curl -X POST http://127.0.0.1:4173/api/calls/CALL_ID/verify \
  -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' -d '{"confirmed":true}'
curl -X POST http://127.0.0.1:4173/api/calls/CALL_ID/claim \
  -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' -d '{"claimId":"CLM-PA-02600"}'
```

5. Build the explanation, prepare a handoff, and complete the call:

```bash
curl -X POST http://127.0.0.1:4173/api/calls/CALL_ID/explanation \
  -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' -d '{}'
curl -X POST http://127.0.0.1:4173/api/calls/CALL_ID/handoff \
  -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' -d '{}'
curl -X POST http://127.0.0.1:4173/api/calls/CALL_ID/complete \
  -H 'Authorization: Bearer TOKEN' -H 'Content-Type: application/json' -d '{}'
curl http://127.0.0.1:4173/api/audit -H 'Authorization: Bearer TOKEN'
```

Explanation and handoff retries return saved results. A handoff is `PREPARED`, with `externalActionSent=false`. Lookup requires full exact references and allows at most five attempts per call. A session lasts 60 minutes by default. Invalid transitions return 409; a missing or unowned call has the same 404 response.

## Endpoint groups

| Group | Endpoints |
| --- | --- |
| Status | GET `/api/health`, `/api/meta`, `/api/openapi.json` |
| Sessions | POST `/api/auth/demo`, `/api/auth/login`, `/api/auth/logout`; GET `/api/auth/me` |
| Claims | GET `/api/claims`, `/api/claims/:id`, `/api/claims/:id/evidence` |
| Policy | GET `/api/policies?plan=...&version=...`, `/api/policies/:id` |
| Metrics | GET `/api/stats` (counts from the dataset/current operator's latest 100 calls) |
| Calls | GET/POST `/api/calls`; GET `/api/calls/:id`; POST suffixes `/verify`, `/claim`, `/explanation`, `/handoff`, `/complete`, `/cancel` |
| Advisory | POST `/api/jev/shadow` with `{ "claimId": "CLM-PA-02600" }` |
| Review | GET `/api/handoffs`, `/api/audit?limit=100` |
| Admin | GET `/api/admin/dataset`, `/api/admin/audit/integrity` |

Claim filters: `q`, `outcome` (Denied, Partially paid, Pending), `risk` (LOW, MEDIUM, HIGH), `escalation` (true/false), `limit` (1-100), `offset` (0-10000). Search does not perform fuzzy matching in the caller workflow.

For cookie authentication, mutations require the `X-CSRF-Token` returned by login or `/api/auth/me`. Only same-host or explicitly configured CORS origins are accepted. Bearer authentication is useful for API testing. Responses are not cached. Request bodies are capped at 16 KiB. The default limits are 300 requests/minute/IP, 20 login/demo session attempts/minute/IP and 10 explanation/shadow attempts/minute/operator. Exceeding a limit returns 429 and `Retry-After`.

JEV disabled/failure responses intentionally return HTTP 200 with `status=unavailable`, a fallback `reason`, and the deterministic `finalRouting`, because the explanation workflow remains available. Authentication, request validation, lookup and permission failures still use normal error statuses. The endpoint accepts only a stored claim ID, never a client-supplied claim object or risk value.

For Windows PowerShell without curl syntax, use `Invoke-RestMethod`, or run `node scripts/smoke.mjs` to exercise the complete workflow automatically.
