# Continuous Integration

## Purpose

Every pull request and every push to `main` must pass platform quality gates
before merge. CI uses isolated service containers and never requires production
secrets.

## Workflow

File: `.github/workflows/ci.yml`

Triggers:

- `pull_request`
- `push` to `main`

## Gates

| Step | Command | Notes |
|---|---|---|
| Install | `npm ci` | Uses lockfile; cache via setup-node |
| Lint | `npm run lint` | ESLint flat config |
| Typecheck | `npm run typecheck` | packages + web + worker |
| Unit/contract | `npm test` | Vitest named projects |
| Integration | `npm run test:integration` | DB/Redis/storage probes |
| Route handlers | `npm run test:handler` | HTTP handler behavior against isolated services |
| Browser E2E | `npm run test:browser` | Real production web server and Playwright Chromium |
| Build | `npm run build` | worker typecheck + Next production build |

## Service containers

| Service | Image | Host port |
|---|---|---:|
| PostgreSQL | `postgres:16-alpine` | 5432 |
| PostgreSQL (E2E) | `postgres:16-alpine` | 5433 |
| Redis | `redis:7-alpine` | 6379 |
| MinIO | `minio/minio` (pinned release tag) | 9000 |

CI and Compose use the second PostgreSQL service at port 5433 for browser E2E
isolation. Without Compose, Playwright defaults to the local `aistudy_e2e`
database on port 5432. The reset script rejects every database name that does
not end in `_e2e`.

CI environment variables match `.env.example` defaults for local fixtures only.
They are not production credentials.

## Local verification

### Unit-only path

No service containers are required:

```bash
npm run verify:ci
npx vitest run --project unit
```

`verify:ci` checks the workflow and heavy-task wrapper contracts. Unit success
is not evidence that PostgreSQL repositories, route handlers, Redis/MinIO
probes, browser flows, or the production build pass.

### Full local path

Prerequisites:

- Node.js 20 or newer and `npm ci` completed.
- Docker with PostgreSQL, isolated PostgreSQL E2E, Redis, and MinIO running via
  `npm run compose:up`.
- `.env` copied from `.env.example`; the E2E database name must end in `_e2e`.
- Playwright Chromium installed with `npx playwright install chromium`.

Run the gates serially:

```bash
npm run compose:up
npm run db:migrate
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:handler
npm run test:browser
npm run build
```

`run-heavy.sh` uses `flock`, `nice`, `ionice`, and `taskset` only when each tool
is available. On Windows Git Bash or minimal containers, unavailable host
scheduling controls produce one warning and the requested command still runs;
its exit code is preserved. This fallback removes a portability blocker but
does not provide cross-process serialization.

### Authoritative merge gate

The GitHub Actions `quality` job is authoritative because it installs from the
lockfile, starts isolated services, installs Chromium, and executes every gate
from a clean checkout. A dirty local working tree or a passing unit-only run is
not release evidence.

## Failure policy

- PR checks are required before merge.
- Failing logs must not print secrets (env contract + health responses already
  strip credentials).
- Cache must not hide missing dependencies: always `npm ci` from lockfile.
