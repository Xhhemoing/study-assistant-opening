# ADR-001: Initial Platform Stack

**Status:** Accepted  
**Date:** 2026-07-22  
**Deciders:** AIstudy implementers (session approval of architecture rethink)  
**Related:**  
- `docs/plans/2026-07-22-system-architecture-rethink-design.md`  
- `docs/plans/2026-07-21-lifelong-learning-implementation.md` Task 1  
- `spikes/**`

## Context

AIstudy is a cloud-first lifelong learning platform. Product design requires:

- modular monolith (`web` + `worker`);
- PostgreSQL as system of record;
- async AI/document work that never blocks notes, practice, or review;
- self-hostable deployment later;
- TypeScript as the sole business backend language until an extension gate is met.

Milestone 0 / Task 1 requires pinning versions only after **executable spikes**, not by assumption.

## Decision

Adopt the following stack for Phase 0–MVP:

| Layer | Choice | Pinned version (spike) | Evidence |
|---|---|---|---|
| Runtime | Node.js | `>=20` (validated on `v24.18.0`) | workspace engines + local run |
| Language | TypeScript (product code) | spike tests written as TS ESM | all spikes |
| Web | Next.js App Router + React | `next@15.5.21`, `react@19.1.9`, `react-dom@19.1.9` | `spikes/web` health route |
| ORM | Drizzle ORM + `postgres`.js | `drizzle-orm@0.44.7`, `postgres@3.4.7` | `spikes/database` |
| Database | PostgreSQL | `16.14` (local) | migration/tx/JSONB test |
| Queue | BullMQ + ioredis | `bullmq@5.56.10`, `ioredis@5.6.1` | `spikes/queue` jobId idempotency |
| Session primitive | `jose` (JWS) | `jose@6.2.4` | `spikes/auth` |
| Object storage client | AWS SDK v3 S3 + presigner | `@aws-sdk/client-s3@3.832.0`, `@aws-sdk/s3-request-presigner@3.832.0` | `spikes/storage` |
| Unit/integration test | Vitest | `vitest@4.1.10` | all spikes |
| E2E browser | Playwright Chromium | `playwright@1.53.2` | `spikes/test-tooling` |
| Monorepo | npm workspaces | npm `11.16.0` | root `package.json` |

### Architecture invariants locked with this ADR

1. **Primary backend language is TypeScript.**  
2. **Processes:** `apps/web` (sync API/UI) + `apps/worker` (async).  
3. **Heterogeneous workers (e.g. Python)** only after the extension gate in the architecture rethink design; they must use versioned job contracts and must not own formal domain writes.  
4. **AI writes candidates only**; formal content requires human accept/edit/reject.  
5. **Learning events are append-only**; assessments/plans are versioned derived projections.

## Alternatives considered

| Alternative | Decision | Why |
|---|---|---|
| Python (FastAPI/Django) as main API | Rejected | Dual stack for auth/events/permissions; breaks TypeScript contracts sharing; higher self-host cost |
| Go/Rust main API | Rejected | Slower product iteration; weaker shared domain typing with Next.js |
| Day-1 microservices + multi-language | Rejected | No load evidence; violates modular-monolith priority |
| Prisma | Deferred | Drizzle spike passed with explicit SQL/migrations and lower magic; Prisma may be reconsidered only with a new ADR |
| Full Auth.js/Better Auth in spike | Deferred | Session/authz primitive proven with `jose`; production library chosen in auth feature task with self-host cookie constraints |
| Live MinIO in spike | Deferred | Presign URL generation validated offline; compose service lands in Task 3 / infra |
| Yarn/pnpm | Rejected for Phase 0 | npm workspaces sufficient; avoid extra package manager constraint for self-host docs |

## Self-hosting constraints

- Node `>=20` required.  
- PostgreSQL 16+ recommended (JSONB, `gen_random_uuid()`).  
- Redis required for BullMQ workers.  
- S3-compatible storage endpoint must support path-style addressing for MinIO-like targets (`forcePathStyle: true` in spike).  
- Playwright browser binaries are a **dev/CI** dependency, not a runtime dependency of the product containers.  
- Install note: shells with `NODE_ENV=production` omit devDependencies; repo `.npmrc` sets `include=dev` for local/spike installs. Production images should still install only runtime deps explicitly.

## Upgrade policy

1. Pin exact versions in workspace `package.json` files; commit `package-lock.json`.  
2. Minor/patch upgrades require green `npm test --workspaces --if-present` plus later monorepo lint/typecheck/build gates.  
3. Major upgrades (Next, Drizzle, BullMQ, Playwright) require a new spike or ADR amendment.  
4. Do not introduce a second business backend language without meeting the extension gate and writing ADR-00x.

## Spike results (2026-07-22)

Command:

```bash
npm test --workspaces --if-present
```

Result: **PASS** for all six spikes:

- `@aistudy/spike-web` — App Router `GET` health JSON  
- `@aistudy/spike-database` — JSONB insert in transaction; forced rollback isolation  
- `@aistudy/spike-queue` — duplicate `jobId` executes once  
- `@aistudy/spike-auth` — signed session + object-level deny  
- `@aistudy/spike-storage` — presigned PUT/GET URL shape  
- `@aistudy/spike-test-tooling` — Vitest + Playwright Chromium

## Consequences

- Task 2 may scaffold `apps/*` and `packages/*` on this stack without re-debating language.  
- Production auth library, compose services, and CI matrix remain follow-up tasks (not unblocked product domain work beyond stack choice).  
- Spikes stay in-repo as executable regression for stack assumptions until replaced by monorepo integration tests.

## Official sources consulted

- Next.js App Router docs (Route Handlers, self-hosting Node server)  
- Drizzle ORM PostgreSQL docs  
- BullMQ jobId / deduplication docs  
- PostgreSQL JSONB and transaction docs  
- AWS SDK v3 S3 presigner docs  
- Vitest + Playwright docs  
