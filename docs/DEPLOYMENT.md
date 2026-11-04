# Deployment and recovery

## Local development

Use Node.js 24.15+ from the 24.x line. The repository has zero package dependencies. `node server.mjs` applies SQL migrations, seeds an empty database, and serves the frontend and backend together. If port 4173 is busy, set `PORT` in `.env`. `node scripts/database.mjs` checks migrations and audit-chain integrity independently.

## Docker

Start Docker Desktop in Linux-container mode (or a Linux Docker daemon), then run `docker compose up --build -d`. Run `node scripts/smoke.mjs` against the running service. The `claims-data` volume persists sessions and workflow records. Compose binds to `127.0.0.1:4173`; use a HTTPS reverse proxy for remote access rather than exposing the demo directly.

The image excludes `.env`, scratch/build outputs, `.git`, and runtime databases. Compose passes explicitly listed settings at runtime. Set `COOKIE_SECURE=true` behind HTTPS and set `CORS_ORIGINS` to exact frontend origins if needed. Keep the frontend on the backend's origin for the included cookie integration. Never bake credentials into the image.

Node built-in SQLite requires Node 24.x as specified by `package.json`. Use a persistent volume at `/app/storage`. Run a single application instance per database volume. `APP_ENV=demo` is explicit even though the container sets `NODE_ENV=production` for runtime optimizations; the latter does not make this a production insurer system. `APP_ENV=production` is intentionally rejected.

## GitHub

Create an empty GitHub repository without an initial README and use its clone URL:

```bash
git remote add origin <YOUR_GITHUB_REPOSITORY_URL>
git push -u origin main
```

CI runs automatically on pushes and pull requests. It tests the API, checks the synthetic dataset and API documentation, builds the Docker image, and runs the end-to-end smoke script against a container. It does not publish an image, deploy the app, or consume a JEV secret. Tests stub provider HTTP calls. Configure protected branches and repository secrets in GitHub only if you later add a deployment workflow.

## Hosting

Deploy to a host that supports a persistent Node/Docker service, with startup command `node server.mjs`, health path `/api/health`, bind address `HOST=0.0.0.0`, and a persistent SQLite location in `DATABASE_PATH`. Configure HTTPS and secure cookies. Set your own admin password if disabling demo login.

The existing Netlify Drop site contains static files and cannot execute this Node backend or persist SQLite. This repository serves the same UI together with the new API from a Node/Docker host. A separate Netlify frontend would need explicit API-base configuration and an authentication/CORS deployment design; that hosted site's build was not changed by this repository task.

The legacy `scripts/build-worker.mjs` packager now refuses to build: it bypassed the persistent session/workflow backend. The prior prototype remains available in Git history. Use the Node service or Docker deployment above.

## Backup and recovery

For this demo, stop the service before copying its storage directory/volume. Back up the main SQLite database and any WAL/SHM sidecars together, or use a SQLite-aware online backup tool. Do not copy only a live main `.sqlite` file while WAL is active. Restore a backup into the stopped service's volume and start the service. Run `node scripts/database.mjs` to verify migrations and the audit chain.

The seed is loaded only into an empty claims table, so a restart never wipes calls or imports fixtures twice. Interrupted investigations return to MATCHED on startup and may be requested again. Previously prepared handoffs remain idempotent. No external insurer action is implemented or automatically replayed.

## Verification record

The local API/unit tests cover authentication, ownership, CSRF/origins, exact lookup/limits, pending/evidence gates, audit immutability, restart persistence and JEV contracts/fallback. Container execution additionally depends on an available Docker daemon. No production-readiness, real caller identity, real telephony, policy-semantic validation, or live JEV performance claim follows from these demo tests.
