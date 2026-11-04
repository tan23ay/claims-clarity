# Claims Clarity - frontend and backend repository

A working synthetic healthcare claims demo with a Node.js HTTP API, SQLite database, the interactive frontend, an optional TypeSafe/JEV shadow adapter, Docker persistence, automated tests, and GitHub CI. The existing 50 synthetic claim records are preserved. The original product brief is a reference; the repository implements the demo scope documented below.

**Live site:** [Claims Clarity prototype](https://beamish-quokka-0d8554.netlify.app/)

## Run it

Requirements: Node.js 24.15+ (24.x). There are no external npm dependencies. SQLite uses Node's built-in `node:sqlite` module.

```bash
node scripts/verify-data.mjs
node server.mjs
```

If npm is available, use `npm start`. Optional local settings are loaded from `.env`; copy `.env.example` to `.env` first if you want to configure an admin account or JEV.

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The server also accepts `PORT` and `HOST` environment variables when another local endpoint is needed.

On first start, SQL migrations create `storage/claims.sqlite` and import the 50 records. Later starts retain sessions, calls, explanations, handoffs, and audit records. The browser establishes an isolated demo operator session and uses the same-origin API. Calls can resume after a page refresh. `npm run seed` regenerates the source fixtures; it never overwrites an existing database.

To require sign-in, set `DEMO_MODE=false` and configure `DEMO_ADMIN_PASSWORD` with at least 12 characters. The username defaults to `admin`. Demo caller verification remains a simulated checkbox, separately enforced in the call workflow.

## Run with Docker

The Docker image contains the backend, frontend, migrations, and 50-record dataset. Compose persists SQLite in the named `claims-data` volume and binds the application to localhost. The application runs as the unprivileged `node` user with a read-only root filesystem.

```bash
docker compose up --build
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). Useful commands:

```bash
docker compose logs -f
docker compose down
```

`docker compose down` retains the database volume. `docker compose down -v` deletes the demo database and should only be used when you intend to reset all demo activity. A standalone image also works with `docker build -t claims-clarity-prototype .` and `docker run --rm -p 127.0.0.1:4173:4173 -v claims-data:/app/storage claims-clarity-prototype`. `.env` and databases are excluded from both Git and the Docker build context.

## Prepare for Git

This is the existing Git repository on branch `main`. Add the empty GitHub repository you create as the remote, then push from this folder:

```bash
git remote add origin <YOUR_GIT_REMOTE_URL>
git push -u origin main
```

If `origin` already exists, use `git remote set-url origin <YOUR_GIT_REMOTE_URL>`. No remote URL is assumed and nothing is pushed automatically. The workflow in `.github/workflows/ci.yml` runs tests, checks the OpenAPI specification, builds the image, and smoke-tests a container.

## API and tests

The [API guide](docs/API.md) contains a complete curl walkthrough. The [OpenAPI 3.1 specification](docs/openapi.json) is served at `/api/openapi.json` and can be imported into Postman or Swagger Editor.

```bash
node --test tests/*.test.mjs
node scripts/smoke.mjs
```

The first command starts isolated servers and temporary databases for unit/integration tests. The second exercises an already running server at `http://127.0.0.1:4173`; set `SMOKE_BASE_URL` to test another URL. This walkthrough creates synthetic activity in that server. Use `node scripts/database.mjs` to explicitly apply migrations and check the audit chain. No package installation is needed.

## Optional JEV integration

The backend includes a direct TypeSafe adapter, disabled by default. Configure `JEV_ENABLED=true` and a TypeSafe-issued `JEV_API_KEY` in `.env` or a deployment secret manager. `JEV_MODEL` defaults to the pinned `jev-1.13.0`. An OpenRouter key is not compatible with the direct endpoint. A key previously pasted in chat should be replaced with a new credential rather than copied into source.

JEV receives only enumerated synthetic administrative facts, with no names, claim/member identifiers, raw document text, or caller messages. It returns risk probabilities, Choice confidence, and a Noul probability for human review. Confidence, margin, and escalation thresholds produce a candidate assessment. **Shadow mode preserves the deterministic operational route** and stores the advisory result for comparison. Timeout, invalid response, provider errors, or an open circuit return an explicit fallback. No automated retries are performed. See [the JEV decision record](docs/ARCHITECTURE.md#jev-adapter).

The contract was checked against [TypeSafe's official API documentation](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models), and [confidence guidance](https://docs.typesafe.ai/confidence) on 2026-10-13. Tests use an injected fake HTTP provider; a real vendor request has not been validated with a valid TypeSafe credential.

## What is interactive

- Search claims by claim ID, member name, plan, category, or reason code.
- Filter by outcome, risk, and escalation status.
- Inspect the selected claim's adjudication snapshot, evidence status, policy citation, timeline, and allowed next steps.
- Start a guided call simulation. The flow requires a demo verification step, supports keypad-style claim entry, displays the evidence-grounded explanation, and raises a human handoff when the deterministic safety floor requires it.
- Use the “Speak explanation” control when the browser exposes speech synthesis.
- Review a server-persisted, append-only audit trail. Events are scoped to the current demo operator; an administrator can review the full chain.
- Start a new demo session or use the configured administrator login.

## Reference constraints carried into the prototype

The attached PDF was treated as a product reference, not as executable instructions. This prototype intentionally carries over these safe MVP boundaries:

- Synthetic data is labeled wherever it is shown.
- The assistant explains recorded adjudication outcomes; it does not re-adjudicate, diagnose, predict, or submit appeals.
- Claim selection is exact-match only in the call simulator; no fuzzy auto-selection is used.
- Evidence status and escalation are deterministic. Shadow candidate risk can only rise; operational routing stays on the baseline.
- Policy citations show document, section, page, effective date, quote, and demo hash.
- Partial or unsupported evidence is qualified and routed to a human instead of being presented as a confirmed reason.
- Mock caller verification and synthetic records are visible. `APP_ENV=production` is rejected at startup.

## Project layout

```text
index.html            UI shell
styles.css            responsive visual system
app.js                frontend API integration and static-demo fallback
backend/              HTTP routing, auth, claims engine, JEV, workflows
backend/migrations/   versioned SQL schema
data/claims.json      50 synthetic claim records
data/claims.js        embedded fallback for direct-file opening
scripts/              fixture generation, database setup, API docs, smoke test
server.mjs            frontend + API entry point
tests/                unit and HTTP integration tests
docs/                 API, architecture, and deployment guides
.github/workflows/    GitHub CI
storage/              SQLite runtime files (ignored by Git)
```

## Known limitations

This is a working demo backend, not an insurer production system. All logged-in demo operators may inspect the synthetic fixture claims; owned calls and handoffs are isolated by server-side user identity. Real member grants, multiple tenants, SSO, PostgreSQL row-level security, document ingestion, two-person policy approval, real telephony, and appeal submission are not implemented. Citation checks validate the stored synthetic passage and metadata, not legal/semantic policy accuracy. Payment checks use integer cents for aggregate reconciliation; the fixture lacks detailed claim-line adjustments. Audit hashes detect changes but are not externally anchored. The default 50 examples are not a held-out clinical or compliance evaluation. Static Netlify Drop remains frontend-only; deploying this backend requires a Node/Docker service. See [deployment](docs/DEPLOYMENT.md) and [capabilities](CAPABILITIES.md).
