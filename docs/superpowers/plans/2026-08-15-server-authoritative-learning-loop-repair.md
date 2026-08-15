# Server-Authoritative Learning Loop Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hybrid mock learning path with a server-authoritative, replayable learning loop whose content, grading, events, SRS state, assessment, plan, delayed outcomes, backup, and verification evidence are trustworthy.

**Architecture:** PostgreSQL owns versioned practice content and immutable personal events. A practice session records server-observed assistance, the attempt service grades against the stored content version, and pure domain functions derive status and plans from repository reads. Mock providers remain only as explicit fixtures/demo adapters; AI and asynchronous work stay outside the synchronous learning path and are introduced only after the rule-based loop is verified.

**Tech Stack:** TypeScript 5.8, Next.js App Router, PostgreSQL 16, Drizzle ORM, Zod 4, Vitest 4, Playwright, BullMQ/Redis only in the later production-worker task.

## Global Constraints

- Preserve every existing workspace authorization check; route input must never choose an effective `workspaceId` or `ownerUserId`.
- Do not modify a migration that has run in any shared environment. Confirm `schema_migrations` before editing `0012` or `0013`; otherwise add the next numbered migration.
- Learning events are append-only facts. Assessment snapshots and plans are derived and replaceable.
- The synchronous attempt path must work when Redis, S3, AI providers, and the worker are unavailable.
- Client values for correctness, syllabus point, ability slice, content version, hint count, answer reveal, and duration are not authoritative.
- New or changed UI uses Tailwind utilities only, no inline `style` and no new native CSS files.
- Split new modules before 200 lines; do not add more responsibilities to `apps/web/src/features/auth/service.ts` or `packages/database/src/repositories/library.ts`.
- Use TDD for every behavior change: failing test, smallest implementation, same test passing, then broader verification.
- Every task closes only the `AIST-*` issues explicitly listed under it; update the issue register with commit and command evidence after verification.

## Authoritative References

- Issue register: `docs/quality/2026-08-15-learning-loop-issue-register.md`
- Product contract: `docs/product/PRD.md`
- AI/UX limits: `docs/product/UX_AND_AI_POLICY.md`
- Event/assessment principles: `docs/architecture/DATA_MODEL_AND_PREDICTION.md`
- Migration operations: `docs/operations/database-migrations.md`

---

## File and Module Map

### Existing modules retained

- `packages/domain/src/practice/grading.ts`: pure answer normalization and typed answer-rule evaluation.
- `packages/domain/src/assessment/from-events.ts`: converts persisted events into assessment evidence.
- `packages/domain/src/assessment/status.ts`: deterministic rule assessment.
- `packages/domain/src/planning/planner.ts`: deterministic plan builder.
- `packages/domain/src/srs/scheduler.ts`: current versioned baseline SRS algorithm.
- `packages/database/src/repositories/learning-events.ts`: append and replay repository, extended with list queries.
- `packages/database/src/repositories/cards*.ts`: card and review state repository, hardened for concurrency.

### New focused modules

- `packages/contracts/src/practice-content.ts`: public practice item, internal answer rule, practice session and route schemas.
- `packages/contracts/src/learning-read-models.ts`: assessment, correction, plan mutation and diagnostics route schemas.
- `packages/database/src/schema/practice-content.ts`: content package, syllabus, item version and practice session tables.
- `packages/database/src/repositories/practice-content.ts`: workspace-bound content/version queries.
- `packages/database/src/repositories/practice-sessions.ts`: session start, assistance tracking and transactional completion.
- `packages/database/src/repositories/goals.ts`: workspace-bound study goal CRUD over the evolved goal schema.
- `packages/database/src/repositories/plan-state.ts`: selected option and task status/lock overlays.
- `apps/web/src/features/practice/practice-service.ts`: principal-bound item/session/hint/reveal service.
- `apps/web/src/features/assessment/assessment-service.ts`: event replay and correction service.
- `apps/web/src/features/today-plan/today-plan-service.ts`: server plan assembly and overlay service.
- `apps/web/src/lib/data/server/`: typed API clients implementing the learning-provider interfaces.

### Migration sequence reserved by this plan

Use the numbers below only after confirming `0012` and `0013` are the latest migrations in every target environment:

1. `0014_learning_event_delete_guard.sql`
2. `0015_practice_content.sql`
3. `0016_goal_and_plan_state.sql`
4. `0017_account_deletion.sql`
5. `0018_intervention_outcomes.sql`
6. `0019_outbox.sql`

If another migration lands first, renumber all not-yet-applied files while preserving their dependency order.

---

### Task 0: Freeze the Repair Baseline and Make Quality Commands Cross-Platform

**Closes:** AIST-006 partially, AIST-014 partially

**Depends on:** none

**Files:**
- Modify: `scripts/run-heavy.sh`
- Modify: `scripts/verify-ci.mjs`
- Modify: `docs/operations/ci.md`
- Modify: `README.md`
- Create: `docs/releases/phase-1-repair-baseline.md`
- Test: `scripts/verify-ci.mjs`

**Interfaces:**
- Consumes: existing npm scripts in `package.json`.
- Produces: the same command names and exit codes on Linux/CI, WSL and Git Bash; no command silently skips its requested validation.

- [x] **Step 1: Record the immutable baseline before changing code**

Run:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff --stat
find packages/database/src/migrations -maxdepth 1 -type f -name '*.sql' | sort
```

Write the branch, commit SHA, 92-item working-tree warning, migration list, known verification output, and the statement “uncommitted files are not released capability” to `docs/releases/phase-1-repair-baseline.md`.

- [x] **Step 2: Add a structural test for optional host scheduling tools**

Extend `scripts/verify-ci.mjs` to assert that `scripts/run-heavy.sh`:

```js
assert.match(runHeavy, /command -v flock/);
assert.match(runHeavy, /command -v taskset/);
assert.match(runHeavy, /exec .*"\$@"/s);
```

The contract is: use locking/de-prioritization when available; run the requested command directly when unavailable.

- [x] **Step 3: Run the structural check and observe failure**

Run:

```bash
npm run verify:ci
```

Expected: FAIL because `run-heavy.sh` currently calls host-specific commands unconditionally.

- [x] **Step 4: Make `run-heavy.sh` fail open only for optional scheduling tools**

Implement this behavior:

```bash
if command -v flock >/dev/null 2>&1 && [[ "${HERMES_HEAVY_LOCK_HELD:-0}" != 1 ]]; then
  # retain the existing lock and timeout behavior
fi

run=("$@")
if command -v nice >/dev/null 2>&1; then run=(nice -n "${HERMES_HEAVY_NICE:-12}" "${run[@]}"); fi
if command -v ionice >/dev/null 2>&1; then run=(ionice -c 3 "${run[@]}"); fi
if command -v taskset >/dev/null 2>&1 && taskset -c 0 true >/dev/null 2>&1; then
  run=(taskset -c 0 "${run[@]}")
fi
exec "${run[@]}"
```

Do not suppress the child command’s exit status. Print one concise warning when `flock` is unavailable.

- [x] **Step 5: Align CI documentation with actual prerequisites**

Document three paths in `docs/operations/ci.md`:

```text
Unit only: no services; npx vitest run --project unit
Full local: Docker Compose + Playwright Chromium + .env
Authoritative merge gate: GitHub Actions quality job
```

Update README’s current-stage section from task-number claims to three lists: committed and verified, present but not fully verified, planned.

- [x] **Step 6: Verify the baseline task**

Run:

```bash
npm run verify:ci
npx vitest run --project unit
npx tsc -p packages/domain/tsconfig.json --noEmit
npx tsc -p packages/contracts/tsconfig.json --noEmit
```

Expected: structural check passes; unit suite remains green; typechecks exit 0.

- [x] **Step 7: Commit the baseline separately**

```bash
git add scripts/run-heavy.sh scripts/verify-ci.mjs docs/operations/ci.md README.md docs/releases/phase-1-repair-baseline.md
git commit -m "docs: freeze learning-loop repair baseline"
```

---

### Task 1: Enforce Database-Level Learning Event Immutability

**Closes:** AIST-004

**Depends on:** Task 0

**Files:**
- Create: `packages/database/src/migrations/0014_learning_event_delete_guard.sql`
- Modify: `tests/integration/learning-event-idempotency.test.ts`
- Modify: `docs/operations/database-migrations.md`

**Interfaces:**
- Consumes: `learning_events` from migration `0012`.
- Produces: a database trigger that rejects ordinary DELETE while retaining INSERT and correction events.

- [ ] **Step 1: Confirm whether migrations 0012/0013 have run**

With the configured test database running:

```bash
psql "$DATABASE_URL" -c "select id, checksum, applied_at from schema_migrations order by id"
```

If `0012_learning_events.sql` appears, do not edit it. This plan always uses a new migration so local and shared environments behave identically.

- [ ] **Step 2: Write the failing delete-protection test**

Add to `tests/integration/learning-event-idempotency.test.ts` using the file’s existing `workspaceId`, `ownerUserId`, `contentId`, `syllabusPointId`, `occurredAt` and `attemptPayload` fixtures:

```ts
it("rejects direct deletion while allowing correction append", async () => {
  const event = await events.append({
    workspaceId,
    ownerUserId,
    type: "attempt",
    idempotencyKey: "attempt-delete-guard-01",
    occurredAt,
    contentId,
    contentVersion: 1,
    syllabusPointId,
    payload: attemptPayload,
  });

  await expect(sql`DELETE FROM learning_events WHERE id = ${event.id}`).rejects.toThrow(
    /learning_events are append-only/,
  );

  await expect(events.append({
    workspaceId,
    ownerUserId,
    type: "correction",
    idempotencyKey: "correction-after-delete-guard-01",
    occurredAt: "2026-08-15T03:05:00.000Z",
    correctsEventId: event.id,
    syllabusPointId,
    payload: {
      kind: "status",
      note: "状态需要人工复核",
      overrideStatus: "weak",
    },
  })).resolves.toMatchObject({
    type: "correction",
    correctsEventId: event.id,
  });
});
```

- [ ] **Step 3: Run the focused integration test and observe failure**

```bash
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/learning-event-idempotency.test.ts
```

Expected: DELETE succeeds, causing the assertion to fail.

- [ ] **Step 4: Add the guard migration**

Create a trigger function and trigger:

```sql
CREATE OR REPLACE FUNCTION learning_events_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'learning_events are append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS learning_events_no_delete ON learning_events;
CREATE TRIGGER learning_events_no_delete
  BEFORE DELETE ON learning_events
  FOR EACH ROW
  EXECUTE FUNCTION learning_events_reject_delete();
```

Do not add a session-variable bypass. A controlled account-deletion mechanism belongs to Task 10 and must use an explicitly privileged administrative path.

- [ ] **Step 5: Verify migration ordering and behavior**

```bash
npm run db:migrate
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/learning-event-idempotency.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/migration-order.test.ts
```

Expected: all pass; migration registry contains `0014` once.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/migrations/0014_learning_event_delete_guard.sql tests/integration/learning-event-idempotency.test.ts docs/operations/database-migrations.md
git commit -m "fix: prevent learning event deletion"
```

---

### Task 2: Add Versioned Practice Content and Server-Observed Practice Sessions

**Closes:** AIST-005; prepares AIST-001

**Depends on:** Task 1

**Files:**
- Create: `packages/contracts/src/practice-content.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/practice-content.test.ts`
- Create: `packages/database/src/schema/practice-content.ts`
- Create: `packages/database/src/migrations/0015_practice_content.sql`
- Create: `packages/database/src/repositories/practice-content.ts`
- Create: `packages/database/src/repositories/practice-sessions.ts`
- Modify: `packages/database/src/index.ts`
- Create: `tests/integration/practice-content-repository.test.ts`

**Interfaces:**
- Produces:

```ts
type AnswerRule =
  | { type: "exact"; accepted: string[] }
  | { type: "token_set"; accepted: string[][] };

type PublicPracticeItem = {
  id: string;
  contentVersion: number;
  syllabusPointId: string;
  kind: "multiple_choice" | "short_answer" | "checkpoint";
  stem: string;
  options?: string[];
  abilitySlice: AbilitySlice;
  estimatedMinutes: number;
  availableHintCount: number;
};

type PracticeSessionRecord = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  practiceItemId: string;
  contentVersion: number;
  startedAt: string;
  hintCount: number;
  answerRevealedAt: string | null;
  submittedAt: string | null;
};
```

- [ ] **Step 1: Write contract tests before schemas**

Test that `publicPracticeItemSchema` rejects `answer` and `answerRule`, `answerRuleSchema` normalizes non-empty accepted answers, and practice session responses never expose another workspace/user identity chosen by request input.

- [ ] **Step 2: Run contract tests and observe missing exports**

```bash
npx vitest run --project unit packages/contracts/src/practice-content.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the contracts**

Create schemas for:

```ts
startPracticeRequestSchema = z.object({ practiceItemId: z.string().uuid() });
startPracticeResponseSchema = z.object({ sessionId: z.string().uuid(), item: publicPracticeItemSchema });
requestHintResponseSchema = z.object({ hintIndex: z.number().int().nonnegative(), hint: z.string().min(1) });
revealAnswerResponseSchema = z.object({ answer: z.string().min(1) });
```

Keep `AnswerRule` internal to repository/service responses; do not include it in the public item response.

- [ ] **Step 4: Write repository integration tests**

Cover:

```text
workspace-bound package/item reads
current and historical version reads
public item omits answer
start session binds principal, item and version
hint request increments server count atomically
answer reveal records timestamp
submitted session cannot be reused with a different idempotency key
archived item cannot start a new session, but historical version remains readable
```

- [ ] **Step 5: Run repository tests and observe missing tables/repositories**

```bash
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/practice-content-repository.test.ts
```

Expected: FAIL because the schema and repositories do not exist.

- [ ] **Step 6: Add the content migration**

Create these tables with workspace guard triggers following existing repository conventions:

```text
content_packages
- id, workspace_id, title, version, status, created_at, updated_at

syllabus_nodes
- id, workspace_id, package_id, parent_id, code, title, sort_order

practice_items
- id, workspace_id, package_id, current_version, archived_at, created_at

practice_item_versions
- practice_item_id, version, workspace_id, syllabus_point_id, kind, stem,
  options jsonb, answer_rule jsonb, answer_display, hints jsonb,
  ability_slice, estimated_minutes, source jsonb, review_status, created_at
- primary key (practice_item_id, version)

practice_sessions
- id, workspace_id, owner_user_id, practice_item_id, content_version,
  started_at, hint_count, answer_revealed_at, submitted_at,
  submission_idempotency_key
```

Add checks for known kinds, positive versions/minutes, non-negative hint counts and JSON shapes validated again at the Zod boundary.

- [ ] **Step 7: Implement repositories**

`createPracticeContentRepository(sql)` must provide:

```ts
getPublicItem({ workspaceId, itemId }): Promise<PublicPracticeItem>;
getGradableVersion({ workspaceId, itemId, version }): Promise<GradablePracticeItem>;
listSyllabusPoints({ workspaceId, packageId }): Promise<SyllabusPointRecord[]>;
listPracticeCandidates({ workspaceId, packageId }): Promise<PracticeCandidateRecord[]>;
```

`createPracticeSessionRepository(sql)` must provide transaction-safe:

```ts
start(input): Promise<PracticeSessionRecord>;
lock(input): Promise<PracticeSessionRecord>; // SELECT ... FOR UPDATE
recordHint(input): Promise<{ session: PracticeSessionRecord; hint: string }>;
recordAnswerReveal(input): Promise<PracticeSessionRecord>;
markSubmitted(input): Promise<PracticeSessionRecord>;
```

Every method receives workspace and owner from the principal-bound service, not request JSON.

- [ ] **Step 8: Verify contracts, integration and database types**

```bash
npx vitest run --project unit packages/contracts/src/practice-content.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/practice-content-repository.test.ts
npx tsc -p packages/contracts/tsconfig.json --noEmit
npx tsc -p packages/database/tsconfig.json --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/practice-content.ts packages/contracts/src/practice-content.test.ts packages/contracts/src/index.ts packages/database/src/schema/practice-content.ts packages/database/src/migrations/0015_practice_content.sql packages/database/src/repositories/practice-content.ts packages/database/src/repositories/practice-sessions.ts packages/database/src/index.ts tests/integration/practice-content-repository.test.ts
git commit -m "feat: store versioned practice content"
```

---

### Task 3: Move Grading and Attempt Facts to the Server

**Closes:** AIST-001

**Depends on:** Task 2

**Files:**
- Modify: `packages/contracts/src/attempts.ts`
- Modify: `packages/contracts/src/attempts.test.ts`
- Modify: `packages/domain/src/practice/grading.ts`
- Modify: `packages/domain/src/practice/grading.test.ts`
- Create: `apps/web/src/features/practice/practice-service.ts`
- Modify: `apps/web/src/features/practice/attempt-service.ts`
- Modify: `apps/web/src/features/practice/attempt-service.test.ts`
- Create: `apps/web/src/app/api/practice/[id]/route.ts`
- Create: `apps/web/src/app/api/practice/[id]/hint/route.ts`
- Create: `apps/web/src/app/api/practice/[id]/reveal/route.ts`
- Modify: `apps/web/src/app/api/attempts/route.ts`
- Modify: `apps/web/src/lib/data/persist-attempt.ts`
- Modify: `tests/integration/handler/attempts.test.ts`
- Modify: `tests/e2e/practice-player.spec.ts`

**Interfaces:**
- Replaces the current client-authoritative attempt input with:

```ts
type SubmitAttemptRequest = {
  practiceSessionId: string;
  answer: string;
  confidence: 1 | 2 | 3 | 4 | 5;
  errorCause: ErrorCause | null;
  idempotencyKey: string;
};

type SubmitAttemptResponse = {
  event: AttemptEvent;
};

// Task 5 extends this response with `status: StatusResult` after the
// server assessment replay service exists.
```

- [ ] **Step 1: Write the malicious-client tests first**

Change `submitAttemptRequestSchema` to `.strict()` so obsolete or forged authority fields fail visibly instead of being stripped. Update contract and handler tests to assert:

```ts
expect(submitAttemptRequestSchema.safeParse({
  practiceSessionId,
  answer: "wrong",
  confidence: 5,
  errorCause: null,
  idempotencyKey: "attempt-0001",
  correct: true,
  syllabusPointId: attackerPoint,
  abilitySlice: "transfer",
}).success).toBe(false);
```

Handler cases must also prove the server stores the item version’s syllabus point and ability slice, not attacker values.

- [ ] **Step 2: Run tests and observe the old contract accepting forged facts**

```bash
npx vitest run --project unit packages/contracts/src/attempts.test.ts apps/web/src/features/practice/attempt-service.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project handler tests/integration/handler/attempts.test.ts
```

Expected: new assertions fail.

- [ ] **Step 3: Make grading accept a typed server answer rule**

Refactor `isPracticeAnswerCorrect` into:

```ts
export function gradePracticeAnswer(rule: AnswerRule, answer: string): boolean;
```

Rules:

```text
exact: normalized answer equals one accepted normalized value
token_set: normalized comma-delimited set equals one accepted set
```

Do not use unrestricted substring matching for authoritative grading. Preserve the old helper only inside mock fixtures until Task 7 removes the production dependency.

- [ ] **Step 4: Implement principal-bound practice session routes**

- `POST /api/practice/:id` starts a session and returns a public item.
- `POST /api/practice/:id/hint` verifies session ownership, atomically increments hint count and returns one hint.
- `POST /api/practice/:id/reveal` records answer reveal before returning the display answer.

The route URL item ID and session’s item ID must match.

- [ ] **Step 5: Implement one transactional attempt submission**

Inside `submitAttemptForPrincipal`, use `runtime.sql.begin` and transaction-scoped repositories:

```ts
const session = await sessions.lock({ workspaceId, ownerUserId, sessionId });
const item = await content.getGradableVersion({
  workspaceId,
  itemId: session.practiceItemId,
  version: session.contentVersion,
});
const correct = gradePracticeAnswer(item.answerRule, parsed.answer);
const assisted = session.hintCount > 0 || session.answerRevealedAt !== null;
const durationMs = Math.max(0, submittedAt.getTime() - new Date(session.startedAt).getTime());
```

Append the event using only server-derived:

```ts
contentId: item.id;
contentVersion: item.contentVersion;
syllabusPointId: item.syllabusPointId;
payload.correct = correct;
payload.abilitySlice = item.abilitySlice;
payload.hintCount = session.hintCount;
payload.assisted = assisted;
payload.durationMs = durationMs;
```

Mark the session submitted in the same transaction. An idempotent retry returns the existing event; a different idempotency key for a submitted session returns conflict.

- [ ] **Step 6: Remove client grading from persistence**

`persistAttempt()` sends only `practiceSessionId`, answer, confidence, errorCause and idempotency key. Remove the import of `isPracticeAnswerCorrect` from `apps/web/src/lib/data/persist-attempt.ts`.

- [ ] **Step 7: Update the browser flow**

The practice player must start a server session, request hints through the hint route, reveal answers through the reveal route, and submit with the returned session ID. Assert in Playwright that the browser cannot receive `answerRule` in the start response.

- [ ] **Step 8: Verify**

```bash
npx vitest run --project unit packages/contracts/src/attempts.test.ts packages/domain/src/practice/grading.test.ts apps/web/src/features/practice/attempt-service.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project handler tests/integration/handler/attempts.test.ts
npx playwright test tests/e2e/practice-player.spec.ts
npx tsc -p packages/domain/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/attempts.ts packages/contracts/src/attempts.test.ts packages/domain/src/practice/grading.ts packages/domain/src/practice/grading.test.ts apps/web/src/features/practice/practice-service.ts apps/web/src/features/practice/attempt-service.ts apps/web/src/features/practice/attempt-service.test.ts apps/web/src/app/api/practice apps/web/src/app/api/attempts/route.ts apps/web/src/lib/data/persist-attempt.ts tests/integration/handler/attempts.test.ts tests/e2e/practice-player.spec.ts
git commit -m "fix: grade practice attempts on the server"
```

---

### Task 4: Serialize Card Grading and Recheck Idempotency Under Lock

**Closes:** AIST-003

**Depends on:** Task 1

**Files:**
- Modify: `packages/database/src/repositories/cards-grade.ts`
- Modify: `packages/database/src/repositories/cards-ops.ts`
- Create: `tests/integration/card-concurrency.test.ts`
- Modify: `tests/integration/card-multi-goal-state.test.ts`

**Interfaces:**
- Retains `gradeCard()` public signature.
- Produces serial state transitions per `(workspaceId, ownerUserId, cardId)`.

- [ ] **Step 1: Write the concurrent-grade tests**

Use two SQL clients and a synchronization barrier so both requests target the same card. Test:

```text
two different idempotency keys => two review events, reps increases by 2
same idempotency key => one event and one state transition
database failure after state calculation => neither event nor state update commits
```

- [ ] **Step 2: Run the test repeatedly and reproduce lost update**

```bash
for i in 1 2 3 4 5; do
  DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/card-concurrency.test.ts || break
done
```

Expected before repair: at least one run reports event/state mismatch or `reps` increasing once.

- [ ] **Step 3: Lock a stable row before state lookup**

Inside the transaction:

```sql
SELECT id FROM cards
WHERE workspace_id = $workspace AND owner_user_id = $owner AND id = $card
FOR UPDATE;
```

Then recheck the idempotency key under that card lock. Read the existing review state with `FOR UPDATE`. Locking the card row also serializes the first review when no state row exists yet.

- [ ] **Step 4: Keep state and event in one transaction**

Calculate `next`, write state, append event and return without leaving the transaction. Map unique-key replay only after confirming the existing event belongs to the same card and event type.

- [ ] **Step 5: Verify repeatedly**

```bash
for i in 1 2 3 4 5; do
  DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/card-concurrency.test.ts
done
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/card-multi-goal-state.test.ts
npx tsc -p packages/database/tsconfig.json --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/repositories/cards-grade.ts packages/database/src/repositories/cards-ops.ts tests/integration/card-concurrency.test.ts tests/integration/card-multi-goal-state.test.ts
git commit -m "fix: serialize concurrent card grading"
```

---

### Task 5: Add Event Replay Queries and Principal-Bound Assessment APIs

**Closes:** AIST-008 partially; prepares AIST-002

**Depends on:** Tasks 1–3

**Files:**
- Create: `packages/contracts/src/learning-read-models.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/attempts.ts`
- Modify: `packages/contracts/src/attempts.test.ts`
- Modify: `packages/database/src/repositories/learning-events.ts`
- Create: `apps/web/src/features/assessment/assessment-service.ts`
- Create: `apps/web/src/features/assessment/assessment-service.test.ts`
- Modify: `apps/web/src/features/practice/attempt-service.ts`
- Modify: `apps/web/src/features/practice/attempt-service.test.ts`
- Create: `apps/web/src/app/api/assessment/route.ts`
- Create: `apps/web/src/app/api/assessment/corrections/route.ts`
- Create: `tests/integration/handler/assessment.test.ts`
- Modify: `tests/integration/handler/attempts.test.ts`
- Modify: `tests/integration/assessment-replay.test.ts`

**Interfaces:**

```ts
LearningEventRepository.listForOwner(input: {
  workspaceId: string;
  ownerUserId: string;
  syllabusPointId?: string;
  occurredBefore?: string;
}): Promise<LearningEvent[]>;

GET /api/assessment?syllabusPointId=<uuid>
=> { statuses: StatusResult[] }

POST /api/assessment/corrections
<= { correctsEventId, kind: "status", note, overrideStatus?, idempotencyKey }
=> { event: LearningEvent, status: StatusResult }
```

- [ ] **Step 1: Write repository ordering and isolation tests**

Assert `listForOwner` returns events ordered by `occurred_at ASC, created_at ASC, id ASC`, excludes other workspaces and can filter one syllabus point.

- [ ] **Step 2: Write service tests for deterministic replay**

Cover attempt + review + correction, assisted exclusion, disabled slices, late events and identical snapshot IDs for identical evidence/time inputs.

- [ ] **Step 3: Run focused tests and observe missing interfaces**

```bash
npx vitest run --project unit apps/web/src/features/assessment/assessment-service.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/assessment-replay.test.ts
```

- [ ] **Step 4: Implement list queries and assessment service**

Group evidence by `syllabusPointId`; call `deriveStatus` with a server clock and correction events. Do not persist a snapshot table yet. Return `evidenceSnapshotId`, `strategyVersion`, `modelVersion` from the existing domain result. Extend `submitAttemptResponseSchema` to `{ event, status }`; after the Task 3 transaction commits, `submitAttemptForPrincipal` invokes the assessment service for the event’s syllabus point and returns that server-derived status.

- [ ] **Step 5: Implement correction append**

Load the target event within the principal workspace. Ignore request workspace/user fields. Append a `correction` event and recompute the affected point.

- [ ] **Step 6: Add handler authorization tests**

Cover unauthenticated 401, own workspace success, cross-workspace target hidden, malformed correction 400 and idempotent replay.

- [ ] **Step 7: Verify**

```bash
npx vitest run --project unit apps/web/src/features/assessment/assessment-service.test.ts packages/domain/src/assessment
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/assessment-replay.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project handler tests/integration/handler/assessment.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/learning-read-models.ts packages/contracts/src/index.ts packages/contracts/src/attempts.ts packages/contracts/src/attempts.test.ts packages/database/src/repositories/learning-events.ts apps/web/src/features/assessment/assessment-service.ts apps/web/src/features/assessment/assessment-service.test.ts apps/web/src/features/practice/attempt-service.ts apps/web/src/features/practice/attempt-service.test.ts apps/web/src/app/api/assessment tests/integration/handler/assessment.test.ts tests/integration/handler/attempts.test.ts tests/integration/assessment-replay.test.ts
git commit -m "feat: replay assessment from learning events"
```

---

### Task 6: Persist Study Goals and Plan Interaction State

**Closes:** AIST-002 partially, AIST-008 partially

**Depends on:** Task 5

**Files:**
- Modify: `packages/database/src/schema/goals.ts`
- Create: `packages/database/src/schema/plan-state.ts`
- Create: `packages/database/src/migrations/0016_goal_and_plan_state.sql`
- Create: `packages/database/src/repositories/goals.ts`
- Create: `packages/database/src/repositories/plan-state.ts`
- Modify: `packages/database/src/index.ts`
- Create: `tests/integration/study-goal-repository.test.ts`
- Create: `tests/integration/plan-state-repository.test.ts`
- Create: `apps/web/src/features/goals/goal-service.ts`
- Create: `apps/web/src/app/api/goals/route.ts`
- Create: `apps/web/src/app/api/goals/[id]/route.ts`
- Create: `tests/integration/handler/goals.test.ts`

**Interfaces:**

```ts
GoalRepository = {
  list(input): Promise<StudyGoal[]>;
  get(input): Promise<StudyGoal>;
  create(input): Promise<StudyGoal>;
  update(input): Promise<StudyGoal>;
  archive(input): Promise<StudyGoal>;
};

PlanStateRepository = {
  getDay(input): Promise<{ selectedOptionId: string | null; tasks: TaskOverlay[] }>;
  selectOption(input): Promise<void>;
  setTaskStatus(input): Promise<void>;
  setTaskLock(input): Promise<void>;
};
```

- [ ] **Step 1: Write migration/repository tests**

Cover a goal without a course, a goal attached to an own-workspace course, cross-workspace course rejection, archive behavior, dailyMinutes bounds, task overlays scoped by owner/date and selected option snapshot matching.

- [ ] **Step 2: Run and observe missing persistence**

```bash
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/study-goal-repository.test.ts tests/integration/plan-state-repository.test.ts
```

- [ ] **Step 3: Evolve `course_goals` rather than creating a second goal truth source**

Migration changes:

```sql
ALTER TABLE course_goals ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE course_goals ADD COLUMN scenario text NOT NULL DEFAULT 'final';
ALTER TABLE course_goals ADD COLUMN subjects jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE course_goals ADD COLUMN daily_minutes integer NOT NULL DEFAULT 45;
ALTER TABLE course_goals ADD CONSTRAINT course_goals_daily_minutes_chk
  CHECK (daily_minutes BETWEEN 5 AND 600);
```

Replace the unconditional `(workspace_id, course_id, kind)` unique index with a partial unique index for active, non-archived, course-bound goals. Preserve existing rows by deriving `scenario` from `kind` in a data migration before making the final constraint effective.

Create:

```text
daily_plan_choices(workspace_id, owner_user_id, plan_date, selected_option_id,
  evidence_snapshot_id, updated_at)
plan_task_states(workspace_id, owner_user_id, plan_date, task_id,
  status, locked, updated_at)
```

- [ ] **Step 4: Implement repositories and service mapping**

Map `StudyGoal.scenario` to existing goal kind with the domain registry. Validate `courseId` through the course repository when non-null. Derive `ownerUserId` from the principal, never request input.

- [ ] **Step 5: Implement goal routes and handler tests**

- `GET/POST /api/goals`
- `GET/PATCH/DELETE /api/goals/:id`, where DELETE archives rather than physically deletes.

- [ ] **Step 6: Verify**

```bash
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/study-goal-repository.test.ts tests/integration/plan-state-repository.test.ts tests/integration/multi-goal-course.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project handler tests/integration/handler/goals.test.ts
npx tsc -p packages/database/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add packages/database/src/schema/goals.ts packages/database/src/schema/plan-state.ts packages/database/src/migrations/0016_goal_and_plan_state.sql packages/database/src/repositories/goals.ts packages/database/src/repositories/plan-state.ts packages/database/src/index.ts tests/integration/study-goal-repository.test.ts tests/integration/plan-state-repository.test.ts apps/web/src/features/goals/goal-service.ts apps/web/src/app/api/goals tests/integration/handler/goals.test.ts
git commit -m "feat: persist study goals and plan state"
```

---

### Task 7: Build the Server Today-Plan Read Model and Remove Mock Reads from Learn

**Closes:** AIST-002, AIST-008

**Depends on:** Tasks 4–6

**Files:**
- Create: `apps/web/src/features/today-plan/today-plan-service.ts`
- Create: `apps/web/src/features/today-plan/today-plan-service.test.ts`
- Create: `apps/web/src/app/api/plans/today/route.ts`
- Create: `tests/integration/handler/today-plan.test.ts`
- Create: `apps/web/src/lib/data/server/fetch-json.ts`
- Create: `apps/web/src/lib/data/server/learning-provider.ts`
- Modify: `apps/web/src/lib/data/react.ts`
- Modify: `apps/web/src/lib/data/types.ts`
- Modify: `apps/web/src/features/learn/today-plan-view.tsx`
- Modify: `apps/web/src/features/practice/practice-player.tsx`
- Modify: `apps/web/src/features/practice/practice-result.tsx`
- Modify: `apps/web/src/features/review/review-session.tsx`
- Modify: `apps/web/src/features/goals/goal-list.tsx`
- Modify: `apps/web/src/features/goals/goal-detail.tsx`
- Modify: `apps/web/src/features/goals/goal-wizard.tsx`
- Modify: `tests/e2e/today-plan.spec.ts`
- Create: `tests/e2e/server-learning-persistence.spec.ts`

**Interfaces:**

```ts
GET /api/plans/today?date=YYYY-MM-DD => TodayPlan
PATCH /api/plans/today <=
  | { action: "select_option"; date; optionId; evidenceSnapshotId }
  | { action: "set_task_status"; date; taskId; status }
  | { action: "set_task_lock"; date; taskId; locked }
```

- [ ] **Step 1: Write service tests for plan assembly**

Use repository fakes to prove the service reads goals, content points, assessment statuses, due reviews and plan overlays; calls `buildTodayPlan`; rejects stale option selections when `evidenceSnapshotId` changed.

- [ ] **Step 2: Write browser persistence tests before rewiring**

The E2E flow must:

```text
register
create/use seeded goal
start server practice session
submit an attempt
observe assessment and plan
clear localStorage
reload
observe the same assessment/plan
open a second browser context for the same account
observe the same server data
```

Expected before rewiring: FAIL after localStorage clear.

- [ ] **Step 3: Implement today-plan service and route**

Assemble `PlannerInput` from:

```text
active goals -> budget/scenario
content repository -> syllabus points and practice candidates
assessment service -> status per point
card repository -> due review cards
plan-state repository -> selected option and task overlays
```

Apply overlays only to task IDs present in the current plan. Ignore stale overlays and retain them only for audit/debugging until a cleanup policy is defined.

- [ ] **Step 4: Implement the server learning provider**

`createServerLearningProvider()` implements the learning-critical subset:

```ts
listGoals/getGoal/createGoal/updateGoal/archiveGoal
getTodayPlan/selectPlanOption/setTaskStatus/toggleTaskLock
startPractice/getPracticeItem/requestHint/revealAnswer/submitAttempt
listStatuses/recordStatusCorrection
listDueCards/createReviewCard/gradeCard
getDiagnostics
```

All API responses must pass Zod schemas. `fetchJson` converts structured API errors into stable client errors.

- [ ] **Step 5: Split provider hooks by responsibility**

Expose:

```ts
useLearningProvider(): LearningDataProvider | null;
useExplorationProvider(): ExplorationDataProvider | null;
```

Learn, goals, practice, review, assessment and diagnostics components use `useLearningProvider`. Do not instantiate `createMockProvider()` in the production Learn path. Keep an explicit `createDemoStudyProvider()` export only for tests/story fixtures.

- [ ] **Step 6: Verify unit, handler and browser behavior**

```bash
npx vitest run --project unit apps/web/src/features/today-plan apps/web/src/lib/data
DATABASE_URL="$DATABASE_URL" npx vitest run --project handler tests/integration/handler/today-plan.test.ts tests/integration/handler/goals.test.ts tests/integration/handler/assessment.test.ts tests/integration/handler/reviews.test.ts
npx playwright test tests/e2e/today-plan.spec.ts tests/e2e/server-learning-persistence.spec.ts
rg -n "createMockProvider" apps/web/src/features/learn apps/web/src/features/goals apps/web/src/features/practice apps/web/src/features/review apps/web/src/features/assessment apps/web/src/lib/data/react.ts
```

Expected: tests pass and the final `rg` produces no production Learn-path match.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/today-plan apps/web/src/app/api/plans apps/web/src/lib/data/server apps/web/src/lib/data/react.ts apps/web/src/lib/data/types.ts apps/web/src/features/learn apps/web/src/features/practice apps/web/src/features/review apps/web/src/features/goals tests/integration/handler/today-plan.test.ts tests/e2e/today-plan.spec.ts tests/e2e/server-learning-persistence.spec.ts
git commit -m "feat: serve the learning loop from persisted events"
```

---

### Task 8: Seed One Auditable MVP Content Package and Define the Measurement Protocol

**Closes:** AIST-010 as an MVP supply gap; narrows AIST-018

**Depends on:** Tasks 2, 3 and 7

**Files:**
- Create: `scripts/seed-mvp-content.ts`
- Create: `docs/product/MVP_PILOT.md`
- Create: `docs/product/MEASUREMENT_PROTOCOL.md`
- Create: `docs/content/mvp-calculus-source-register.md`
- Create: `tests/integration/mvp-content-seed.test.ts`
- Modify: `package.json`
- Modify: `.env.example`

**Interfaces:**
- Produces: idempotent `npm run seed:mvp-content` and a fixed content package ID/version for tests and pilot.

- [ ] **Step 1: Define the fixed pilot before writing content**

`MVP_PILOT.md` must fix:

```text
Audience: university/graduate-exam calculus learner
Scope: derivative definition and basic applications
Syllabus points: 8–15
Content: 30–50 reviewed items
Primary outcome: 7-day independent unseen-variant success
Pilot length: 4–8 weeks
Initial cohort: 10–20 consenting adult users
```

Do not include high-school minors in the first pilot until Task 10’s policy gate is closed.

- [ ] **Step 2: Write the seed round-trip test**

Run the seed twice against an empty database; assert stable IDs, no duplicate package/items, all items have source/review status, every syllabus point has at least two baseline items and one delayed unseen variant.

- [ ] **Step 3: Create reviewed source records**

`mvp-calculus-source-register.md` records for every item group:

```text
source/author or public-domain derivation
license or permission status
reviewer
review date
answer rule rationale
syllabus point
baseline vs intervention vs delayed-validation role
```

Do not copy unlicensed exam questions into the repository.

- [ ] **Step 4: Implement an idempotent seed command**

The script accepts `DATABASE_URL`, resolves one target workspace created by an explicit `--workspace-id`, and upserts by stable IDs. It must refuse a production environment unless `--allow-production` is explicitly supplied and logged.

- [ ] **Step 5: Define measurement eligibility**

`MEASUREMENT_PROTOCOL.md` defines:

```text
eligible intervention
independent attempt
hint/answer contamination
unseen variant
7-day window
missing outcome
ITT denominator
completed-case denominator
minimum sample size before any model claim
```

- [ ] **Step 6: Verify**

```bash
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/mvp-content-seed.test.ts
npm run seed:mvp-content -- --workspace-id "$TEST_WORKSPACE_ID"
npm run seed:mvp-content -- --workspace-id "$TEST_WORKSPACE_ID"
```

Expected: second run changes no counts.

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-mvp-content.ts docs/product/MVP_PILOT.md docs/product/MEASUREMENT_PROTOCOL.md docs/content/mvp-calculus-source-register.md tests/integration/mvp-content-seed.test.ts package.json .env.example
git commit -m "feat: seed an auditable calculus pilot"
```

---

### Task 9: Implement Authorized Native Backup and Restore Instead of a Broken Test Import

**Closes:** AIST-007, AIST-011

**Depends on:** Task 7

**Files:**
- Use: `packages/contracts/src/backup.ts`
- Use: `packages/domain/src/portability/native/`
- Create: `packages/database/src/repositories/native-backup.ts`
- Modify: `packages/database/src/index.ts`
- Create: `apps/web/src/features/library/native-backup-service.ts`
- Create: `apps/web/src/app/api/backups/export/route.ts`
- Create: `apps/web/src/app/api/backups/restore/route.ts`
- Modify: `tests/integration/native-backup-roundtrip.test.ts`
- Modify: `tests/integration/handler/backup-routes-authorization.test.ts`
- Modify: `apps/web/src/features/library/export-menu.tsx`
- Create: `tests/e2e/native-backup.spec.ts`

**Interfaces:**

```text
POST /api/backups/export -> versioned NativeBackupPackage for principal workspace
POST /api/backups/restore -> dry-run plan by default; explicit confirm token applies
```

- [ ] **Step 1: Keep the existing failing handler import as the RED test**

Run:

```bash
DATABASE_URL="$DATABASE_URL" npx vitest run --project handler tests/integration/handler/backup-routes-authorization.test.ts
```

Expected: module-not-found for backup routes.

- [ ] **Step 2: Expand round-trip coverage to all P0 entities**

Assert backup/restore counts and stable references for documents, blocks, revisions, relations, properties, courses, goals, content versions, sessions excluded, cards, review state, learning events and provenance. Do not include password hashes or active session tokens.

- [ ] **Step 3: Implement a read-only export repository**

Every query filters the principal workspace. Produce records in deterministic order and compute the existing native package checksum.

- [ ] **Step 4: Implement dry-run restore planning**

The first request validates package version/checksum and returns conflicts. Applying restore requires a server-generated short-lived confirmation token bound to workspace, package checksum and conflict policy. Cross-workspace IDs never select the target workspace.

- [ ] **Step 5: Apply restore transactionally**

Restore in foreign-key order, never overwrite on `skip`, abort entirely on `reject`, and preserve append-only event payloads. Do not disable immutability triggers through the application role; insert events as new records in an empty/compatible target workspace.

- [ ] **Step 6: Add UI wording**

Keep Markdown and Anki labels as projections with loss reports. Label Native Backup as the only restorable package and show its schema version/checksum.

- [ ] **Step 7: Verify**

```bash
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/native-backup-roundtrip.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project handler tests/integration/handler/backup-routes-authorization.test.ts
npx playwright test tests/e2e/native-backup.spec.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/database/src/repositories/native-backup.ts packages/database/src/index.ts apps/web/src/features/library/native-backup-service.ts apps/web/src/app/api/backups tests/integration/native-backup-roundtrip.test.ts tests/integration/handler/backup-routes-authorization.test.ts apps/web/src/features/library/export-menu.tsx tests/e2e/native-backup.spec.ts
git commit -m "feat: back up and restore learning workspaces"
```

---

### Task 10: Establish Privacy, Deletion and Provider Data Boundaries

**Closes:** AIST-012; defines the controlled exception to AIST-004

**Depends on:** Tasks 1, 7 and 9

**Files:**
- Create: `docs/security/data-inventory.md`
- Create: `docs/security/data-retention-and-deletion.md`
- Create: `docs/security/threat-model.md`
- Create: `docs/security/provider-data-boundary.md`
- Create: `apps/web/src/server/rate-limit.ts`
- Create: `apps/web/src/server/origin-check.ts`
- Create: `apps/web/src/server/mutation-guard.ts`
- Modify: `apps/web/src/features/auth/service.ts`
- Modify: `apps/web/src/app/api/auth/login/route.ts`
- Modify: `apps/web/src/app/api/auth/register/route.ts`
- Modify: `apps/web/src/features/practice/attempt-service.ts`
- Modify: `apps/web/src/features/review/review-service.ts`
- Create: `packages/database/src/migrations/0017_account_deletion.sql`
- Create: `packages/database/src/repositories/account-deletion.ts`
- Modify: `packages/database/src/index.ts`
- Create: `apps/web/src/app/api/account/deletion/route.ts`
- Create: `tests/integration/handler/security-boundaries.test.ts`
- Create: `tests/integration/account-deletion.test.ts`

**Interfaces:**
- Produces a documented field-level purpose/retention/recipient matrix.
- Produces a two-step account deletion request with re-authentication and audit receipt.

- [ ] **Step 1: Inventory data before implementing deletion**

For every table and outbound AI field, document owner, purpose, retention, export inclusion, deletion behavior, telemetry/training eligibility and third-party recipient. Explicitly classify note/exploration free text and learning error history as sensitive education data.

- [ ] **Step 2: Write security boundary tests**

Cover cross-workspace reads/writes, disallowed Origin on cookie-authenticated mutations, login/register/attempt/AI rate limits, secure-cookie production validation, event payload absence from logs and Provider request source allowlists.

- [ ] **Step 3: Implement origin and rate-limit guards**

Use a repository-backed or Redis-backed limiter with a safe local test adapter. `requirePrincipal()` calls the central mutation guard for every non-GET/HEAD authenticated request, so existing authenticated mutation routes inherit the Origin check without dozens of duplicated edits. Login and register call the same guard explicitly before parsing credentials. Redis failure must fail closed for login/AI abuse controls but must not lose an already authenticated attempt; apply a conservative in-process fallback for the attempt endpoint.

- [ ] **Step 4: Design account deletion as an administrative transaction**

Because Task 1 blocks direct event deletion, create `0017_account_deletion.sql` with a dedicated `SECURITY DEFINER` deletion function owned by a fixed maintenance role, a fixed `search_path`, a fully qualified table list and revoked `PUBLIC` execute permission. Replace the Task 1 delete trigger function so it permits deletion only while `current_user` is that exact maintenance owner inside the definer function; the normal application role remains rejected and cannot assume the maintenance role. Grant function execution only to the maintenance runner, never the Web role. The normal Web runtime records a signed deletion request; the privileged maintenance command executes it after the retention window. Test the allowed maintenance deletion and that the application role can neither DELETE learning events directly nor invoke the privileged function.

- [ ] **Step 5: Propagate deletion**

Delete or tombstone, according to the data inventory, account/workspace rows, derived status, plan state, search projections, AI candidates/jobs, outbox payloads and object manifests. Record only a non-identifying deletion receipt.

- [ ] **Step 6: Set the pilot age gate**

Document that the first pilot accepts consenting adults only. Opening to minors requires a separate legal/product decision covering guardian consent, data minimization, deletion and regional requirements.

- [ ] **Step 7: Verify**

```bash
DATABASE_URL="$DATABASE_URL" npx vitest run --project handler tests/integration/handler/security-boundaries.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/account-deletion.test.ts
npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add docs/security apps/web/src/server/rate-limit.ts apps/web/src/server/origin-check.ts apps/web/src/server/mutation-guard.ts apps/web/src/features/auth/service.ts apps/web/src/app/api/auth/login/route.ts apps/web/src/app/api/auth/register/route.ts apps/web/src/features/practice/attempt-service.ts apps/web/src/features/review/review-service.ts packages/database/src/migrations/0017_account_deletion.sql packages/database/src/repositories/account-deletion.ts packages/database/src/index.ts apps/web/src/app/api/account/deletion/route.ts tests/integration/handler/security-boundaries.test.ts tests/integration/account-deletion.test.ts
git commit -m "feat: enforce learning data privacy boundaries"
```

---

### Task 11: Record Delayed Intervention Outcomes Before Adding Advanced Models

**Closes:** AIST-017

**Depends on:** Tasks 7, 8 and 10

**Files:**
- Create: `packages/contracts/src/outcomes.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/database/src/schema/outcomes.ts`
- Create: `packages/database/src/migrations/0018_intervention_outcomes.sql`
- Create: `packages/database/src/repositories/outcomes.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/domain/src/practice/outcomes.ts`
- Create: `packages/domain/src/practice/outcomes.test.ts`
- Create: `apps/web/src/features/practice/outcome-service.ts`
- Create: `apps/web/src/app/api/outcomes/route.ts`
- Create: `tests/integration/intervention-outcome.test.ts`
- Modify: `tests/e2e/server-learning-persistence.spec.ts`

**Interfaces:**

```ts
InterventionAssignment = {
  id; workspaceId; ownerUserId; sourceEventId; syllabusPointId;
  actionCode; assignedAt; checkAt; strategyVersion;
};

OutcomeQualification = {
  eligible: boolean;
  reason: "qualified" | "too_early" | "too_late" | "seen_item" |
    "assisted" | "wrong_slice" | "missing";
};
```

- [ ] **Step 1: Encode the measurement protocol as tests**

Test the exact 7-day window, unseen item requirement, assistance exclusion, same syllabus/slice requirement, missing result and ITT/completed-case denominators.

- [ ] **Step 2: Add append-only assignment/outcome records**

Store assignment and qualified outcome references; do not duplicate the attempt payload. Foreign keys point to source and validation learning events.

- [ ] **Step 3: Link current rule interventions**

When `planIntervention` emits a candidate accepted by the user, append an assignment. The delayed plan surfaces eligible validation items without showing prior answers.

- [ ] **Step 4: Expose aggregate diagnostics only above a minimum sample size**

Return counts, completion, contamination and success rates. Do not emit a probability-calibrated mastery claim or modify planner weights in this task.

- [ ] **Step 5: Verify**

```bash
npx vitest run --project unit packages/domain/src/practice/outcomes.test.ts
DATABASE_URL="$DATABASE_URL" npx vitest run --project integration tests/integration/intervention-outcome.test.ts
npx playwright test tests/e2e/server-learning-persistence.spec.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/outcomes.ts packages/contracts/src/index.ts packages/database/src/schema/outcomes.ts packages/database/src/migrations/0018_intervention_outcomes.sql packages/database/src/repositories/outcomes.ts packages/database/src/index.ts packages/domain/src/practice/outcomes.ts packages/domain/src/practice/outcomes.test.ts apps/web/src/features/practice/outcome-service.ts apps/web/src/app/api/outcomes tests/integration/intervention-outcome.test.ts tests/e2e/server-learning-persistence.spec.ts
git commit -m "feat: measure delayed intervention outcomes"
```

---

### Task 12: Add Transactional Outbox, Real Worker and a Budgeted AI Provider

**Closes:** AIST-009

**Depends on:** Tasks 7, 10 and 11

**Files:**
- Create: `packages/database/src/schema/outbox.ts`
- Create: `packages/database/src/migrations/0019_outbox.sql`
- Create: `packages/database/src/repositories/outbox.ts`
- Create: `packages/database/src/repositories/ai-jobs.ts`
- Create: `packages/database/src/repositories/cost-ledger.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/ai/src/providers/openai-compatible.ts`
- Modify: `packages/ai/src/index.ts`
- Create: `apps/worker/src/queue.ts`
- Create: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/package.json`
- Modify: `packages/config/src/env.ts`
- Modify: `.env.example`
- Create: `tests/integration/outbox-idempotency.test.ts`
- Create: `tests/integration/ai-cost-budget.test.ts`
- Modify: `apps/worker/src/jobs/exploration-chat.ts`

**Interfaces:**

```ts
OutboxRecord = { id; kind; payload; idempotencyKey; status; attempts; availableAt };
AIRequestBudget = { maxInputTokens; maxOutputTokens; maxCostUsd; timeoutMs };
```

- [ ] **Step 1: Write outbox and budget tests first**

Cover same-transaction enqueue, worker retry, restart recovery, dead letter, duplicate job idempotency, per-user/workspace/day budgets, Provider timeout and candidate-only output.

- [ ] **Step 2: Add outbox/job/cost tables**

The request transaction inserts business state plus outbox row. Worker claims with `FOR UPDATE SKIP LOCKED`, publishes to BullMQ or processes directly according to one documented dispatcher mode, and records attempts/status.

- [ ] **Step 3: Implement one OpenAI-compatible provider adapter**

Read endpoint/key/model from validated server environment only. Send only the role-approved source IDs/context from Task 10’s provider boundary. Validate every response with the existing Zod schema.

- [ ] **Step 4: Wire the worker**

Replace `processSmokeJob` as the production entry while retaining it as a health test. Add graceful shutdown, bounded concurrency, retry classification and dead-letter logging without user free text.

- [ ] **Step 5: Guarantee synchronous degradation**

Stop Redis and Provider in integration tests. Attempts, reviews, assessment and rule plans still succeed. AI UI reports queued/failed/retryable rather than inventing a reply.

- [ ] **Step 6: Verify**

```bash
DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" npx vitest run --project integration tests/integration/outbox-idempotency.test.ts tests/integration/ai-cost-budget.test.ts
npx tsc -p packages/ai/tsconfig.json --noEmit
npx tsc -p apps/worker/tsconfig.json --noEmit
npm run build -w @aistudy/worker
```

- [ ] **Step 7: Commit**

```bash
git add packages/database/src/schema/outbox.ts packages/database/src/migrations/0019_outbox.sql packages/database/src/repositories/outbox.ts packages/database/src/repositories/ai-jobs.ts packages/database/src/repositories/cost-ledger.ts packages/database/src/index.ts packages/ai/src/providers/openai-compatible.ts packages/ai/src/index.ts apps/worker/src/queue.ts apps/worker/src/worker.ts apps/worker/src/index.ts apps/worker/package.json packages/config/src/env.ts .env.example tests/integration/outbox-idempotency.test.ts tests/integration/ai-cost-budget.test.ts apps/worker/src/jobs/exploration-chat.ts
git commit -m "feat: run budgeted AI jobs through the outbox"
```

---

### Task 13: Complete the Release Gate, Open-Source Baseline and Module Boundaries

**Closes:** AIST-006, AIST-013, AIST-014; reduces AIST-015

**Depends on:** Tasks 0–12

**Files:**
- Create: `LICENSE` after legal/product approval of the chosen license
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `CODE_OF_CONDUCT.md`
- Modify: `infra/docker/compose.yml`
- Create: `infra/docker/Dockerfile.worker`
- Modify: `docs/operations/cloud-deployment.md`
- Create: `docs/releases/server-authoritative-learning-loop-acceptance.md`
- Modify: `README.md`
- Modify: `TODO.md`
- Refactor without API changes:
  - `apps/web/src/features/auth/service.ts`
  - `packages/database/src/repositories/library.ts`

**Interfaces:**
- Produces a reproducible Compose stack with web, worker, migration job, PostgreSQL, Redis and MinIO.
- Preserves existing public package exports while splitting internal modules.

- [ ] **Step 1: Obtain and record the license decision**

Do not invent a license. Record the approved SPDX identifier and copyright holder, then create the exact standard license text. Keep content-package licenses separate from software code.

- [ ] **Step 2: Add contribution and security governance**

`SECURITY.md` includes a private disclosure channel and supported versions. `CONTRIBUTING.md` documents Node version, service startup, migrations, test gates, conventional commits and the prohibition against editing applied migrations.

- [ ] **Step 3: Add application services to Compose**

Add:

```text
migrate: one-shot migration/preflight job
web: health-gated Next standalone service
worker: health-gated BullMQ/outbox worker
```

Use non-root containers, read-only filesystem where possible, explicit volumes and no embedded production secrets.

- [ ] **Step 4: Split oversized modules only along existing responsibilities**

Move code without changing behavior:

```text
apps/web/src/features/auth/runtime.ts
apps/web/src/features/auth/api-errors.ts
apps/web/src/features/auth/principal-services/*.ts
packages/database/src/repositories/library/documents.ts
packages/database/src/repositories/library/revisions.ts
packages/database/src/repositories/library/relations.ts
packages/database/src/repositories/library/properties.ts
```

Keep `service.ts` and `library.ts` as compatibility barrels until all imports migrate. Run the closest tests after each extraction; do not combine this refactor with feature changes.

- [ ] **Step 5: Run the complete acceptance gate**

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run compose:up
npm run db:migrate
npm run test:integration
npm run test:handler
npx playwright install chromium
npm run test:browser
npm run build
npm run compose:down
```

Expected: every command exits 0. Record exact counts, commit SHA, migration IDs, Node/Playwright versions and CI URL in the acceptance document.

- [ ] **Step 6: Run a backup restore rehearsal**

Export the seeded pilot workspace, restore to the isolated E2E database, compare object/event/card/relation counts and execute one post-restore assessment replay. Record RPO/RTO and any loss report.

- [ ] **Step 7: Update issue status and public claims**

For every closed `AIST-*`, add commit and command evidence to the issue register. README may claim only:

```text
one server-authoritative pilot learning loop
rule-based assessment, not validated prediction
baseline SRS, not FSRS
PostgreSQL FTS/trigram, not vector search
candidate-only budgeted AI when configured
```

Marketplace, teacher, offline, advanced models and pgvector remain explicitly deferred.

- [ ] **Step 8: Commit governance, deployment and refactor in separate commits**

```bash
git add LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md docs
 git commit -m "docs: add open source governance"

git add infra/docker docs/operations/cloud-deployment.md
 git commit -m "feat: compose the complete application stack"

git add apps/web/src/features/auth packages/database/src/repositories/library.ts packages/database/src/repositories/library
 git commit -m "refactor: split oversized service repositories"
```

---

## Deferred Decision Gates

The following are intentionally excluded from repair implementation. Opening one requires a new design and plan with evidence from the pilot:

| Capability | Entry evidence required |
|---|---|
| FSRS/IRT/BKT/sequence models | Rule baseline has enough qualified 7/30-day outcomes and measurable calibration failure |
| AIST-016 pgvector/GraphRAG | A versioned real query set shows FTS/trigram recall is insufficient after permission filtering |
| AIST-010 Marketplace | One maintained content package has stable rights, review, reporting and correction operations |
| AIST-018 Teacher/classroom/LTI/xAPI | Personal-state privacy, aggregation thresholds and role model are approved |
| AIST-018 Offline/CRDT/client | Server event identity, conflict, deletion and sync protocol are stable |
| AIST-013 Plugin SDK | At least two external integrations require the same stable capability boundary |
| Minors pilot | Legal/product approval, guardian/age flow and deletion/retention controls are complete |

## Plan-Wide Verification Matrix

| Evidence | Command / artifact |
|---|---|
| Pure rules/contracts | `npx vitest run --project unit` |
| PostgreSQL invariants | `npm run test:integration` |
| Principal-bound HTTP behavior | `npm run test:handler` |
| Real user flow and persistence | `npm run test:browser` |
| Package/API consistency | `npm run typecheck` |
| Static quality | `npm run lint` |
| Production compilation | `npm run build` |
| Migration safety | `schema_migrations` output + migration-order tests + restore rehearsal |
| Learning value readiness | `docs/product/MEASUREMENT_PROTOCOL.md` + qualified pilot outcomes |
| Issue closure | updated `docs/quality/2026-08-15-learning-loop-issue-register.md` |

## Completion Definition

The repair program is complete only when all statements below are evidenced:

1. The browser cannot choose correctness, syllabus point, ability slice or content version.
2. Practice assistance is recorded by a server session.
3. Learning events reject ordinary UPDATE and DELETE.
4. Concurrent card reviews produce event/state-consistent transitions.
5. Clearing localStorage does not remove goals, plan, status, attempts or review state.
6. A second browser context observes the same server-derived status and plan.
7. AI/Redis failure does not block attempt, review, assessment or rule planning.
8. One reviewed/versioned content package can be seeded from an empty database.
9. A 7-day unseen-variant outcome can be linked to an intervention without assistance contamination.
10. Native backup restores the pilot workspace in an isolated database.
11. Full lint, typecheck, unit, integration, handler, browser and build gates pass.
12. Public documentation distinguishes implemented, configured-optional and deferred capabilities.

## Self-Review

- **Spec coverage:** AIST-001 through AIST-018 are either assigned to a task or explicitly accepted/deferred with an entry gate.
- **Type consistency:** `practiceSessionId`, `PublicPracticeItem`, `AnswerRule`, `LearningEventRepository.listForOwner`, `GoalRepository`, `PlanStateRepository` and plan mutation actions are defined before dependent tasks.
- **Migration consistency:** reserved migrations are ordered; the plan requires renumbering before creation if the repository advances.
- **YAGNI check:** no assessment snapshot table, vector database, advanced learning model, marketplace, classroom, offline sync or plugin SDK is added before evidence requires it.
- **Security check:** principal-derived identity, server grading, assistance tracking, cross-workspace tests, immutable events and controlled deletion are explicit.
