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
| Unit/contract | `npm test` | Vitest workspace projects |
| Integration | `npm run test:integration` | DB/Redis/storage probes |
| Build | `npm run build` | worker typecheck + Next production build |

## Service containers

| Service | Image | Host port |
|---|---|---:|
| PostgreSQL | `postgres:16-alpine` | 5432 |
| Redis | `redis:7-alpine` | 6379 |
| MinIO | `minio/minio` (pinned release tag) | 9000 |

CI environment variables match `.env.example` defaults for local fixtures only.
They are not production credentials.

## Local verification

```bash
npm run verify:ci
```

This runs the same structural contract tests that assert the workflow exists and
contains the required gates, plus the full local quality suite when services
are available.

## Failure policy

- PR checks are required before merge.
- Failing logs must not print secrets (env contract + health responses already
  strip credentials).
- Cache must not hide missing dependencies: always `npm ci` from lockfile.
