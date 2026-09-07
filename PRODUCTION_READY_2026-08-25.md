# PingPong — Production Readiness Completion Report (2026-08-25)

## What was hardened

- Production startup now fails closed when `DATABASE_URL`, `REDIS_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, or `METRICS_TOKEN` is missing.
- Production startup now applies the base PostgreSQL schema, Module 4 wallet ledger schema, and integration migrations before the application starts.
- PostgreSQL migrations are serialized with a PostgreSQL advisory lock so two instances cannot bootstrap the schema concurrently.
- The `app_json_store` schema is now aligned with the runtime persistence layer (`key`, `value`) and includes compatibility logic for the previous `file_key`, `payload` shape.
- Production hydration from PostgreSQL occurs only after the database has been successfully bootstrapped.
- Recharge is fail-closed by default. No UPI destination is hard-coded in application code, and an unconfigured/empty UPI destination cannot silently enable recharge.
- The production payment settings file is disabled until an authorized operator explicitly configures the payment destination and enables recharge.
- Node production baseline is raised to Node 20+, matching the production Docker image.
- The complete automated test suite passes: 35/35 suites.
- JavaScript production preflight passes: 179 JavaScript files syntax-clean.
- Production readiness checks pass.

## Production environment requirements

Required:

- `NODE_ENV=production`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `METRICS_TOKEN`
- `DATABASE_URL`
- `REDIS_URL`

For `VOICE_MODE=sfu` or `VOICE_MODE=staged`, configure:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

For production payment recharge, configure the payment destination from the authenticated Admin/Owner panel. Do not put payment secrets or operator credentials into source code.

## Startup order

1. Validate production configuration.
2. Connect to PostgreSQL.
3. Apply base schema + wallet schema + integration migrations under an advisory lock.
4. Hydrate missing durable JSON mirrors from PostgreSQL.
5. Start the application server.

## Validation performed

- `node scripts/production-preflight.js` — PASS
- `node scripts/production-readiness.js` — PASS
- `node integration_update/database/index.js --dry-run` — PASS
- `npm test` — PASS, 35/35 suites

## Important operational note

The project still contains legacy JSON-backed runtime modules for domains that have not yet been promoted to dedicated relational tables. PostgreSQL is now mandatory in production and provides the durable mirror plus the authoritative Module 4 wallet ledger, but a full domain-by-domain relational migration of every legacy JSON feature is a separate migration program and is not claimed as complete by this package.

## Deployment

Use `scripts/start-production.js` as the production entry point (or the Docker image's default command). Do not use a development command with missing production infrastructure.
