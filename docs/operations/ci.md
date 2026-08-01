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

```bash
npm run verify:ci
```

This runs the structural contract tests that assert the workflow exists and
contains the required gates. Run the commands in the Gates table serially for
the full local quality suite when services are available.

## Failure policy

- PR checks are required before merge.
- Failing logs must not print secrets (env contract + health responses already
  strip credentials).
- Cache must not hide missing dependencies: always `npm ci` from lockfile.
