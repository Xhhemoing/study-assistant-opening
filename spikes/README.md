# Phase 0 Task 1 — Executable Stack Spikes

These spikes validate infrastructure assumptions **before** product code.
Each package has one focused test and no product domain logic.

## Acceptance checklist

| Concern | Assumption proven | Spike | Status |
|---|---|---|---|
| Web | Next.js App Router route handlers run under Node; self-host compatible health JSON | `spikes/web` | **PASS** |
| Auth | Signed session token identifies user; object-level deny works | `spikes/auth` | **PASS** |
| Database | PostgreSQL + Drizzle transaction + JSONB + rollback isolation | `spikes/database` | **PASS** |
| Queue | BullMQ same `jobId` does not execute twice | `spikes/queue` | **PASS** |
| Storage | S3-compatible presigned upload/download URLs | `spikes/storage` | **PASS** |
| Test tooling | Vitest workspace + Playwright Chromium | `spikes/test-tooling` | **PASS** |

Pinned versions and rejected alternatives: `docs/decisions/ADR-001-stack.md`.

## Commands

```bash
# from repo root
npm install
# if Playwright browsers missing:
npx playwright install chromium
npm test --workspaces --if-present
```

Local services used by spikes:

```bash
# PostgreSQL
export DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_spike
# Redis
export REDIS_URL=redis://127.0.0.1:6379
```

## Rules

- No product features inside spikes
- Fail first, then implement the minimum that passes
- Versions locked in ADR-001 after green
