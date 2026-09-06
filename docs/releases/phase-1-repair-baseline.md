# Phase 1 Learning-Loop Repair Baseline

## Current HEAD vs this snapshot

This file remains the 2026-08-15 frozen snapshot (`HEAD` then `ef0334f`). Do not rewrite the historical sections below.

```text
current branch: feat/complete-phase1-current-work
current HEAD: 146d6662a74c0dc957b59f2ab505342b08e214e2
current HEAD subject: Merge remote-tracking branch 'origin/dev' into feat/complete-phase1-current-work
```

Since the snapshot:

- `911dd37` committed the then-untracked 0012–0015 slice: learning events, cards, `0014` no-delete trigger, `0015` practice content, attempts/reviews, assessment replay, backup/export.
- Current HEAD therefore contains committed migrations `0001`–`0015`, not only `0001`–`0011`.
- The working tree is still dirty with an uncommitted `0016_goal_and_plan_state.sql` and `/api/goals` draft. Those files are user work, not released capability.
- Snapshot numbers (106 working-tree entries, 98→104 unit tests) stay historical. This 2026-09-06 docs alignment did not re-run that suite.

## Snapshot

Recorded on 2026-08-15 before server-authoritative learning-loop repairs.

```text
branch: feat/complete-phase1-current-work
HEAD: ef0334fe1fe77c02f0388068f3e122244e3c40d0
HEAD subject: chore(lint): ignore agent/CI metadata dirs; mark scenario registry done
Node: v24.18.0
npm: 11.16.0
working-tree entries at capture: 106
modified entries: 34
untracked entries: 72
```

The repository requires Node 20 or newer. The captured Node 24 environment is valid for local checks, but the authoritative CI environment currently uses Node 22.

The working tree was already heavily modified before this repair task. Its uncommitted files are not released capability, and their presence is not evidence that a route, migration, test, or UI behavior has passed CI.

## Migration Boundary

Migrations committed at `HEAD`:

```text
0001_library.sql
0002_courses.sql
0003_identity.sql
0004_identity_repair.sql
0005_workspace_preferences.sql
0006_wiki_link_relation_source.sql
0007_search_indexes.sql
0008_explorations.sql
0009_promotions.sql
0010_revision_proposals.sql
0011_goals.sql
```

The working tree also contains untracked `0012_learning_events.sql` and `0013_cards.sql`. Before creating `0014`, query every target database's `schema_migrations` table. Never rewrite an applied migration.

## Known Verification Evidence

Previously observed:

```text
npx vitest run --project unit
98 test files passed
467 tests passed
```

Task 0 RED/GREEN evidence:

```text
npx vitest run --project contract tests/contract/ci-workflow.test.ts
RED: 1 failed, 2 passed; missing optional tools prevented child execution
GREEN: 1 file passed, 3 tests passed
```

Current Task 0 verification:

```text
npm run verify:ci
1 contract file passed, 3 tests passed

npx vitest run --project unit
104 test files passed, 479 tests passed

npx tsc -p packages/domain/tsconfig.json --noEmit
exit 0

npx tsc -p packages/contracts/tsconfig.json --noEmit
exit 0
```

The increase from 98/467 to 104/479 comes from tests present in the dirty working tree. It is local verification evidence, not proof that those uncommitted features are released.

## Environment Gaps at Capture

```text
Docker CLI: unavailable
DATABASE_URL: unset
REDIS_URL: unset
Playwright Chromium cache: present
```

Consequences:

- PostgreSQL integration and handler projects cannot be authoritative local evidence.
- Redis/MinIO probes cannot be completed locally.
- Chromium presence alone is insufficient for browser tests; the isolated E2E database and live server are also required.
- GitHub Actions `quality` remains the authoritative merge gate.

## Scope and Preservation Rule

Task 0 owns only:

```text
scripts/run-heavy.sh
scripts/verify-ci.mjs
tests/contract/ci-workflow.test.ts
docs/operations/ci.md
README.md
docs/releases/phase-1-repair-baseline.md
```

`TODO.md`, the issue register, and the detailed repair plan were created immediately before Task 0 and remain separate audit artifacts. All other modified and untracked paths are preserved as pre-existing/user work.
