# AIstudy Frontend Core Loops Implementation Plan (Plan A)

> **For agentic workers:** Execute task-by-task with TDD. No `git commit` — the user has not authorized commits; each slice ends with gates + a chat progress report instead.

**Goal:** Deliver the PRD P0 core frontend loops (Learn: goals→plan→practice→status→SRS; Explore: mock AI threads + selective promotion; Library: server-persisted block editor + links + search) behind one hybrid DataProvider, per `docs/plans/2026-08-02-frontend-core-loops-design.md`.

**Architecture:** Next.js App Router monolith. Real APIs keep serving auth/documents/courses/preferences; all other domains are served by a browser-side `MockStudyDataProvider` (localStorage, per-user namespace, seeded) that calls **real pure domain functions** in `packages/domain` (srs, assessment, planning, search). New UI uses Tailwind v4 utilities (theme + utilities only, **no preflight**) over the approved dark palette; legacy `globals.css` untouched.

**Tech Stack:** Next.js 15.5.21, React 19.1.9, TypeScript 5.8.3, Zod 4.0.17, BlockNote 0.52.1, Tailwind CSS v4 (`@tailwindcss/postcss`), lucide-react, Vitest 4.1.10 (node env, `renderToStaticMarkup` for component tests).

## Global Constraints

- UI copy zh-CN; dark theme only; status words exactly 稳固/可用/薄弱/未测， never color-only (icon + text).
- New/changed UI uses Tailwind utilities only; do not edit `apps/web/src/app/globals.css`; no inline `style` props.
- No new backend routes; new deps limited to devDependencies `tailwindcss` + `@tailwindcss/postcss` in `apps/web`.
- No third-party UI kit; no global state library (React hooks + localStorage only).
- Component tests live in `*.test.ts` files using `createElement` + `renderToStaticMarkup` (vitest `unit` project includes only `*.test.ts`).
- Domain logic is pure: no UI/infra imports in `packages/domain`; time always injected as `Date`.
- Attempt events append-only with idempotency keys; derived results carry `strategyVersion`/`modelVersion`/`evidenceSnapshotId`.
- Files stay under 200 lines; split subcomponents.
- Gates after every task: `npm run lint`, `npm run typecheck`, `npm test` (add `npm run build` when routes/config change).
- Contracts use existing repo style: `z.string().uuid()`, `z.string().datetime()`.

## File Structure

```text
packages/contracts/src/  goals.ts attempts.ts assessment.ts plan.ts srs.ts exploration.ts diagnostics.ts (+index.ts, +frontend-domains.test.ts)
packages/domain/src/     srs/scheduler.ts assessment/status.ts planning/planner.ts search/query.ts (+index.ts, +tests)
apps/web/postcss.config.mjs + src/app/tailwind.css   Tailwind v4 + tokens
apps/web/src/lib/data/   types.ts mock/storage.ts mock/seeds.ts mock/provider.ts react.ts (+tests)
packages/ui/src/         status-badge.tsx drawer.tsx empty-state.tsx card.tsx field.tsx (+index.ts, +tests)
apps/web/src/features/   editor/ search/ explore/ goals/ courses/ today-plan/ practice/ assessment/ review/ settings/ placeholders/
apps/web/src/app/(workspace)/  learn/... explore/... library/... search/page.tsx settings/page.tsx
```

---

## Slice S0 — Foundation

### Task 1: Tailwind v4 setup + design tokens

**Files:**
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/src/app/tailwind.css`
- Modify: `apps/web/src/app/layout.tsx` (import after globals.css)
- Modify: `apps/web/package.json` (devDependencies)

- [ ] **Step 1:** Add devDeps `"@tailwindcss/postcss": "^4.1.11"`, `"tailwindcss": "^4.1.11"` to `apps/web/package.json`; run `npm install`.
- [ ] **Step 2:** Create `apps/web/postcss.config.mjs`:

```js
export default { plugins: { "@tailwindcss/postcss": {} } };
```

- [ ] **Step 3:** Create `apps/web/src/app/tailwind.css` (theme + utilities only, no preflight so legacy shell stays pixel-identical):

```css
@import "tailwindcss/theme";
@import "tailwindcss/utilities";

@source "../../../packages/ui/src";

@theme {
  --color-ink: #0b1020;
  --color-surface: #121a2b;
  --color-surface-2: #1a2440;
  --color-line: #24304f;
  --color-text: #f5f7ff;
  --color-text-dim: #94a3b8;
  --color-primary: #6ea8fe;
  --color-success: #4ade80;
  --color-warning: #facc15;
  --color-danger: #f87171;
}
```

- [ ] **Step 4:** In `apps/web/src/app/layout.tsx` add `import "./tailwind.css";` directly below `import "./globals.css";`.
- [ ] **Step 5:** Verify `npm run build -w @aistudy/web` passes and `/learn` renders unchanged. Report progress.

### Task 2: Contract schemas for new domains

**Files:**
- Create: `packages/contracts/src/goals.ts`, `attempts.ts`, `assessment.ts`, `plan.ts`, `srs.ts`, `exploration.ts`, `diagnostics.ts`
- Create: `packages/contracts/src/frontend-domains.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces (Produces — every later task consumes these exact names):**

```ts
// goals.ts
export const scenarioPresetSchema = z.enum(["final", "gaokao", "kaoyan", "custom"]);
export const studyGoalSchema = z.object({
  id: z.string().uuid(), ownerUserId: z.string().uuid(),
  title: z.string().min(1).max(80), scenario: scenarioPresetSchema,
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  subjects: z.array(z.string().min(1)).max(12),
  dailyMinutes: z.number().int().min(5).max(600),
  courseId: z.string().uuid().nullable(),
  archivedAt: z.string().datetime().nullable(),
  strategyVersion: z.string().min(1),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export const studyGoalInputSchema = z.object({
  title: z.string().min(1).max(80).default("未命名目标"),
  scenario: scenarioPresetSchema.default("final"),
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  subjects: z.array(z.string().min(1)).max(12).default([]),
  dailyMinutes: z.number().int().min(5).max(600).default(45),
  courseId: z.string().uuid().nullable().default(null),
});
export type ScenarioPreset = z.infer<typeof scenarioPresetSchema>;
export type StudyGoal = z.infer<typeof studyGoalSchema>;
export type StudyGoalInput = z.input<typeof studyGoalInputSchema>;

// attempts.ts
export const abilitySliceSchema = z.enum(["recognition", "recall", "procedure", "transfer", "expression"]);
export const practiceItemKindSchema = z.enum(["multiple_choice", "short_answer", "checkpoint"]);
export const practiceItemSchema = z.object({
  id: z.string().uuid(), syllabusPointId: z.string().uuid(),
  kind: practiceItemKindSchema, stem: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  answer: z.string().min(1), hints: z.array(z.string().min(1)).max(3),
  abilitySlice: abilitySliceSchema,
  estimatedMinutes: z.number().int().min(1).max(60),
  contentVersion: z.number().int().positive(),
});
export const errorCauseSchema = z.enum(["concept", "misread", "calculation", "steps", "time", "other"]);
export const attemptEventSchema = z.object({
  id: z.string().uuid(), ownerUserId: z.string().uuid(),
  practiceItemId: z.string().uuid(), syllabusPointId: z.string().uuid(),
  idempotencyKey: z.string().min(8),
  answer: z.string(), correct: z.boolean(), assisted: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  hintCount: z.number().int().nonnegative(),
  confidence: z.number().int().min(1).max(5),
  errorCause: errorCauseSchema.nullable(),
  abilitySlice: abilitySliceSchema,
  contentVersion: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
});
export type AbilitySlice = z.infer<typeof abilitySliceSchema>;
export type PracticeItem = z.infer<typeof practiceItemSchema>;
export type ErrorCause = z.infer<typeof errorCauseSchema>;
export type AttemptEvent = z.infer<typeof attemptEventSchema>;

// assessment.ts (machine-readable per UX policy §6)
export const statusWordSchema = z.enum(["stable", "usable", "weak", "untested"]);
export const summaryMetricSchema = z.object({ key: z.string(), label: z.string(), value: z.string() });
export const recommendedActionSchema = z.object({ code: z.string(), label: z.string(), estimatedMinutes: z.number().int().positive() });
export const statusResultSchema = z.object({
  syllabusPointId: z.string().uuid(), status: statusWordSchema,
  summaryMetrics: z.array(summaryMetricSchema).max(3),
  reasonCodes: z.array(z.string()).max(3),
  recommendedActions: z.array(recommendedActionSchema).min(1).max(3),
  evidenceSnapshotId: z.string().min(1),
  strategyVersion: z.string().min(1), modelVersion: z.string().min(1),
  computedAt: z.string().datetime(),
});
export type StatusWord = z.infer<typeof statusWordSchema>;
export type StatusResult = z.infer<typeof statusResultSchema>;

// plan.ts
export const plannedTaskKindSchema = z.enum(["practice", "review", "explore", "output"]);
export const plannedTaskSchema = z.object({
  id: z.string().min(1), kind: plannedTaskKindSchema, refId: z.string().min(1),
  title: z.string().min(1), estimatedMinutes: z.number().int().positive(),
  reason: z.string().min(1), locked: z.boolean(),
  status: z.enum(["pending", "done", "skipped"]),
});
export const planOptionSchema = z.object({
  id: z.string().min(1), label: z.string().min(1), description: z.string().min(1),
  tasks: z.array(plannedTaskSchema),
});
export const todayPlanSchema = z.object({
  id: z.string().min(1), ownerUserId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  budgetMinutes: z.number().int().positive(), totalMinutes: z.number().int().nonnegative(),
  tasks: z.array(plannedTaskSchema), options: z.array(planOptionSchema),
  strategyVersion: z.string().min(1), generatedAt: z.string().datetime(),
});
export type PlannedTask = z.infer<typeof plannedTaskSchema>;
export type PlanOption = z.infer<typeof planOptionSchema>;
export type TodayPlan = z.infer<typeof todayPlanSchema>;

// srs.ts
export const reviewGradeSchema = z.enum(["again", "hard", "good", "easy"]);
export const reviewCardSchema = z.object({
  id: z.string().uuid(), ownerUserId: z.string().uuid(),
  front: z.string().min(1), back: z.string().min(1),
  sourceDocumentId: z.string().uuid().nullable(),
  tags: z.array(z.string().min(1)), archived: z.boolean(),
  createdAt: z.string().datetime(),
});
export const reviewStateSchema = z.object({
  cardId: z.string().uuid(), ease: z.number().min(1.3),
  intervalDays: z.number().nonnegative(), dueAt: z.string().datetime(),
  reps: z.number().int().nonnegative(), lapses: z.number().int().nonnegative(),
  lastGrade: reviewGradeSchema.nullable(), updatedAt: z.string().datetime(),
});
export type ReviewGrade = z.infer<typeof reviewGradeSchema>;
export type ReviewCard = z.infer<typeof reviewCardSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;

// exploration.ts
export const aiRoleSchema = z.enum(["retriever", "explainer", "tutor", "challenger", "editor", "examiner", "collaborator", "silent"]);
export const explorationSchema = z.object({
  id: z.string().uuid(), ownerUserId: z.string().uuid(),
  title: z.string().min(1).max(120), status: z.enum(["open", "closed"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export const chatTurnSchema = z.object({
  id: z.string().uuid(), explorationId: z.string().uuid(),
  author: z.enum(["user", "ai"]), aiRole: aiRoleSchema.nullable(),
  content: z.string().min(1), simulated: z.boolean(), createdAt: z.string().datetime(),
});
export const promotionCandidateSchema = z.object({
  id: z.string().uuid(), explorationId: z.string().uuid(), turnId: z.string().uuid(),
  kind: z.enum(["note", "card", "question", "task"]),
  title: z.string().min(1), body: z.string().min(1),
  status: z.enum(["pending", "promoted", "rejected"]),
  promotedTargetId: z.string().nullable(), createdAt: z.string().datetime(),
});
export type AIRole = z.infer<typeof aiRoleSchema>;
export type Exploration = z.infer<typeof explorationSchema>;
export type ChatTurn = z.infer<typeof chatTurnSchema>;
export type PromotionCandidate = z.infer<typeof promotionCandidateSchema>;

// diagnostics.ts
export const diagnosticsSchema = z.object({
  versions: z.record(z.string(), z.string()),
  recentAttemptEvents: z.array(attemptEventSchema).max(20),
  statuses: z.array(statusResultSchema),
  planTaskReasons: z.array(z.object({ taskId: z.string(), reason: z.string() })),
});
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
```

- [ ] **Step 1:** Write failing test `packages/contracts/src/frontend-domains.test.ts`: valid samples parse for each schema; negative cases rejected (bad uuid, confidence 0/6, 4 summaryMetrics, empty recommendedActions, bad examDate, invalid enum, ease 1.2).
- [ ] **Step 2:** Run `npx vitest run packages/contracts/src/frontend-domains.test.ts` → FAIL.
- [ ] **Step 3:** Implement the seven files + `index.ts` re-exports (grouped, existing style).
- [ ] **Step 4:** Run test → PASS; `npm run lint`; `npm run typecheck`. Report progress.

### Task 3: SRS scheduler (`packages/domain/src/srs/scheduler.ts`)

**Interfaces (Produces):**
```ts
export const SRS_VERSION = "srs-1";
export function createInitialState(cardId: string, now: Date): ReviewState;
export function scheduleReview(state: ReviewState, grade: ReviewGrade, now: Date): ReviewState;
```

- [ ] **Step 1:** Write failing test `packages/domain/src/srs/scheduler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInitialState, scheduleReview, SRS_VERSION } from "./scheduler";

const NOW = new Date("2026-08-02T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("srs scheduler srs-1", () => {
  it("starts a new card due immediately with ease 2.5", () => {
    const s = createInitialState("c", NOW);
    expect(s).toMatchObject({ cardId: "c", ease: 2.5, intervalDays: 0, reps: 0, lapses: 0, lastGrade: null });
    expect(s.dueAt).toBe(NOW.toISOString());
  });
  it("again: lapse, ease -0.2, due in 10 minutes", () => {
    const s1 = scheduleReview(createInitialState("c", NOW), "again", NOW);
    expect(s1.lapses).toBe(1);
    expect(s1.ease).toBeCloseTo(2.3);
    expect(Date.parse(s1.dueAt) - NOW.getTime()).toBe(10 * 60 * 1000);
  });
  it("good: first 1 day, then interval * ease", () => {
    const s1 = scheduleReview(createInitialState("c", NOW), "good", NOW);
    expect(s1.intervalDays).toBe(1);
    expect(Date.parse(s1.dueAt) - NOW.getTime()).toBe(DAY);
    const s2 = scheduleReview(s1, "good", new Date(NOW.getTime() + DAY));
    expect(s2.intervalDays).toBe(3); // Math.round(1 * 2.5) = 3 (rounds half up)
  });
  it("easy: first 3 days, ease +0.15", () => {
    const s1 = scheduleReview(createInitialState("c", NOW), "easy", NOW);
    expect(s1.intervalDays).toBe(3);
    expect(s1.ease).toBeCloseTo(2.65);
  });
  it("ease never drops below 1.3", () => {
    let s = createInitialState("c", NOW);
    for (let i = 0; i < 10; i += 1) s = scheduleReview(s, "again", NOW);
    expect(s.ease).toBe(1.3);
  });
  it("deterministic + versioned", () => {
    expect(scheduleReview(createInitialState("c", NOW), "hard", NOW))
      .toEqual(scheduleReview(createInitialState("c", NOW), "hard", NOW));
    expect(SRS_VERSION).toBe("srs-1");
  });
});
```

- [ ] **Step 2:** Run `npx vitest run packages/domain/src/srs/scheduler.test.ts` → FAIL.
- [ ] **Step 3:** Implement (pure; imports only `ReviewGrade`/`ReviewState` types from `@aistudy/contracts`):

```ts
import type { ReviewGrade, ReviewState } from "@aistudy/contracts";

export const SRS_VERSION = "srs-1";
const MIN_EASE = 1.3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createInitialState(cardId: string, now: Date): ReviewState {
  return { cardId, ease: 2.5, intervalDays: 0, dueAt: now.toISOString(), reps: 0, lapses: 0, lastGrade: null, updatedAt: now.toISOString() };
}

export function scheduleReview(state: ReviewState, grade: ReviewGrade, now: Date): ReviewState {
  let ease = state.ease;
  let intervalDays = state.intervalDays;
  let dueInMs: number;
  const lapses = state.lapses + (grade === "again" ? 1 : 0);
  if (grade === "again") {
    ease = Math.max(MIN_EASE, ease - 0.2); intervalDays = 0; dueInMs = 10 * 60 * 1000;
  } else if (grade === "hard") {
    ease = Math.max(MIN_EASE, ease - 0.15);
    intervalDays = intervalDays < 1 ? 1 : Math.round(intervalDays * 1.2); dueInMs = intervalDays * DAY_MS;
  } else if (grade === "good") {
    intervalDays = intervalDays < 1 ? 1 : Math.round(intervalDays * ease); dueInMs = intervalDays * DAY_MS;
  } else {
    ease += 0.15; intervalDays = intervalDays < 1 ? 3 : Math.round(intervalDays * ease * 1.3); dueInMs = intervalDays * DAY_MS;
  }
  return {
    cardId: state.cardId, ease: Number(ease.toFixed(2)), intervalDays,
    dueAt: new Date(now.getTime() + dueInMs).toISOString(),
    reps: state.reps + 1, lapses, lastGrade: grade, updatedAt: now.toISOString(),
  };
}
```

- [ ] **Step 4:** Run test → PASS; update `packages/domain/src/index.ts` to re-export scheduler; gates. Report.

### Task 4: Assessment status derivation (`packages/domain/src/assessment/status.ts`)

**Interfaces (Produces):**
```ts
export const ASSESSMENT_VERSION = "assess-1";
export interface EvidenceEvent { correct: boolean; assisted: boolean; hintCount: number; confidence: number; slice: AbilitySlice; occurredAt: string; }
export function deriveStatus(syllabusPointId: string, events: EvidenceEvent[], now: Date): StatusResult;
```

**Exact rules:**
1. `effective` = non-assisted events sorted ascending by `occurredAt`.
2. `< 2` effective → `untested`; reasons `["insufficient-evidence"]`; actions `[{code:"baseline", label:"做2道基础识别题", estimatedMinutes:10}]`; metrics only `coverage` = `有效证据 n/6`.
3. Latest effective incorrect → `weak`; reasons prioritized `["recent-failure"]` + `"low-confidence"` (last-3 mean confidence ≤ 2) + `"hint-dependent"` (last-3 mean hintCount ≥ 1.5), max 3; actions `步骤提示题 8min` + `无提示变式 12min`.
4. Else if ≥ 4 effective, last-3 all correct, last-3 mean confidence ≥ 3, and any correct `transfer` event exists → `stable`; reasons `["consistent-success"]`; action `保持节奏：1道迁移题 12min`.
5. Else → `usable`; reasons `["partial-mastery"]`; action `1道变式题巩固 10min`.
6. Metrics: `coverage` = `有效证据 {min(n,6)}/6`; `recentAccuracy` = last-5 effective correct ratio as `{pct}%`. Untested/weak/usable/stable all carry both metrics (untested shows `0/6`, `—`).
7. `evidenceSnapshotId` = `"snap-" + sha1ish(pointId + occurredAt of last event + events.length)` (simple string hash, deterministic); `strategyVersion` = `ASSESSMENT_VERSION`; `modelVersion` = `"rules-1"`; `computedAt` = now ISO.

- [ ] **Step 1:** Write failing test `packages/domain/src/assessment/status.test.ts` covering: untested on 0/1 effective events (assisted don't count); weak on latest failure with `recent-failure`; weak adds `low-confidence` when mean ≤ 2; stable needs transfer + streak (a 4-event all-recognition streak is `usable`, not `stable`); usable middle case; metrics strings; determinism (same input → identical output object).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement per exact rules above (pure, time injected).
- [ ] **Step 4:** Run → PASS; export from domain index; gates. Report.

### Task 5: Planner (`packages/domain/src/planning/planner.ts`)

**Interfaces (Produces):**
```ts
export const PLANNER_VERSION = "plan-1";
export interface PlannerPointInput { pointId: string; title: string; status: StatusWord; estimatedMinutes: number; practiceItemId: string; }
export interface PlannerInput {
  ownerUserId: string; date: string; budgetMinutes: number;
  scenario: ScenarioPreset;
  points: PlannerPointInput[];
  dueReviews: Array<{ cardId: string; front: string; estimatedMinutes: number }>;
  lockedTasks: PlannedTask[]; // carried over, always kept first
}
export function buildTodayPlan(input: PlannerInput): TodayPlan;
```

**Exact rules:**
1. Start with `lockedTasks` (status preserved, `locked: true`); subtract their minutes from budget.
2. Candidate queue by priority tier; tier order depends on scenario: `final|custom` → `[review, weak, untested, usable]`; `gaokao|kaoyan` → `[review, weak, usable, untested]`. `stable` points never enter the queue.
3. Within a tier: due reviews first by cardId asc; points by status then title asc (deterministic).
4. Add candidates while `totalMinutes + next.estimatedMinutes <= budgetMinutes`; skip candidates that don't fit and try the next (single pass, no reordering).
5. Task ids: `"plan-" + date + "-" + kind + "-" + refId`. Reasons: review → `"今日到期的复习卡"`; weak → `"薄弱考点，优先补缺"`; untested → `"尚未测评，先建立基线"`; usable → `"做一道变式保持手感"`. Task titles: point title / card front (first 24 chars).
6. `options` = `[]` (multi-goal conflict options are out of scope for the single-goal baseline; schema already supports them).
7. Output: `{ id: "plan-" + ownerUserId + "-" + date, ownerUserId, date, budgetMinutes, totalMinutes, tasks, options, strategyVersion: PLANNER_VERSION, generatedAt }` where generatedAt = `date + "T00:00:00.000Z"`.

- [ ] **Step 1:** Write failing test `packages/domain/src/planning/planner.test.ts`: budget cap respected; locked tasks kept first and counted; tier order differs by scenario (`final` puts an untested point before a usable one; `gaokao` the reverse); stable excluded; skipped-on-overflow picks a later smaller candidate; determinism; task id/reason strings asserted.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement per rules (pure).
- [ ] **Step 4:** Run → PASS; export from domain index; gates. Report.

### Task 6: Search ranking (`packages/domain/src/search/query.ts`)

**Interfaces (Produces):**
```ts
export interface SearchDoc { id: string; type: "document" | "exploration" | "card" | "course" | "practice"; title: string; body: string; tags: string[]; }
export interface SearchHit { id: string; type: SearchDoc["type"]; title: string; snippet: string; score: number; }
export function rankResults(query: string, docs: SearchDoc[], limit?: number): SearchHit[];
```

**Exact rules:** lowercase; tokens = query split on `/\s+/` (empties dropped). Per doc per token: title includes → +3; any tag includes → +2; body includes → +1. Zero-score docs dropped. Sort by score desc, then title asc. `snippet` = body slice of 60 chars centered on first body token hit, else first 60 chars. Default `limit = 20`.

- [ ] **Step 1:** Write failing test `packages/domain/src/search/query.test.ts`: title beats body; tags scored; empty query → `[]`; limit honored; deterministic tie-break by title.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; export from domain index; gates. Report.

---

## Appendix: Tasks 7–25 (condensed, same rigor)

### Task 7 — Mock storage + seeds (`apps/web/src/lib/data/mock/`)
`storage.ts`: `StorageLike` (get/set/remove), `mockKey(userId,domain)` = `aistudy:mock:v1:{u}:{d}`, `loadDomain/saveDomain/resetDomains`, `browserStorage()`. `seeds.ts`: `SEED_SYLLABUS` (12 高数上 points, ids `11111111-1111-4111-8111-1111111111{01..0c}`), `buildSeedBundle(ownerUserId, now)` → goal(高等数学（上）期末/final/+14d/45min), 20 PracticeItems (9 MC/6 short/5 checkpoint, slices mixed, 5–12min, 1–3 hints, contentVersion 1), attempt history yielding exactly 2 stable/3 usable/2 weak/5 untested via `deriveStatus`, 8 ReviewCards (3 due, 1 archived), 1 exploration + 2 turns + 1 pending note candidate. Tests: storage round-trip/reset/key format; seed bundle passes all contract `.parse`, status distribution 2/3/2/5, 3 due cards.

### Task 8 — `types.ts` + `mock/provider.ts`
`StudyDataProvider` interface (goals CRUD; `getTodayPlan/setTaskStatus/toggleTaskLock`; `getPracticeItem/submitAttempt`; `listStatuses/recordStatusCorrection`; `listDueCards/gradeCard`; explorations CRUD + `sendExplorationMessage` + `setCandidateStatus`; `getDiagnostics`; `searchAll`; `getDocumentTags/setDocumentTags`; `indexDocumentLinks/listBacklinks`; `get/setGuidanceMode`; `resetDemoData`). `createMockProvider({userId, storage, fetchDocuments?, now?})`: lazy seed, `delay(60)`, idempotent `submitAttempt` (dedupe by key → same event + recomputed `deriveStatus`), plan built by `buildTodayPlan` + per-date overlays (done/skipped/locked) from `plans` domain, `silent` role → null AI turn, candidate every 2nd user message (kind cycles note→card→question), `searchAll` merges mock docs + real documents → `rankResults`. Test: in-memory storage + fixed now; dedupe, budget 45, overlays, gradeCard, silent, candidate on 2nd msg, search ranks 导数 card, backlinks after indexing.

### Task 9 — `react.ts` hooks
`useAsyncData(load,deps)` → `{data,error,loading,reload}` (error `加载失败，请重试。`); `useCurrentUserId()` (fetch `/api/auth/me` once, module cache); `useStudyProvider()` (memoized `createMockProvider` with `browserStorage()` + `fetchDocuments` from `GET /api/documents`). No unit test (thin; covered via provider tests); typecheck+lint gate.

### Task 10 — `packages/ui` primitives
`StatusBadge` (稳固/可用/薄弱/未测 = CheckCircle2/CircleDot/AlertTriangle/HelpCircle + text, colors success/primary/warning/text-dim, `aria-label="状态：X"`), `Drawer` (role=dialog, aria-modal, Escape/backdrop close), `EmptyState`, `Card`, `Field` (error role=alert). Test `primitives.test.ts` via createElement+renderToStaticMarkup. Tailwind classes only.

### Task 11 — Server editor
`features/editor/editor-api.ts`: `fetchDocument/createDocument/saveDocument/fetchRevisions` (POST `{title,blocks:[{type:"paragraph"}]}`, PATCH `{title,blocks}`; non-ok → zh error). Test with mocked fetch. `document-editor.tsx`: BlockNote load/save via API, save status, undo/redo, localStorage safety copy. `/library/new` = client create→redirect; new `/library/[id]/page.tsx`; delete `local-note-editor.tsx`.

### Task 12 — `version-history-drawer.tsx`
List revisions (newest first), preview, `恢复此版本` → saveDocument(snapshot) → reload, status `已恢复到 v{n}`.

### Task 13 — Links/tags
`link-utils.ts` `extractWikiLinks(blocks)` (unique `[[标题]]`, nested content); test. `properties-panel.tsx` (tags via provider), `backlinks-panel.tsx` (`listBacklinks(title)` → links; empty `还没有其他笔记链接到这里`). On save → `indexDocumentLinks`.

### Task 14 — Search + palette
`search-results.tsx` + `/search/page.tsx` (grouped hits, per-type links); `command-palette.tsx` (Cmd/Ctrl+K, role=dialog, autofocus, ↑↓/Enter/Escape, 150ms debounce `searchAll`, actions 新建笔记/探索/目标); mount in `workspace-shell.tsx` + utility cluster (search ⌘K button, `/settings` gear); `/library` search box → `/search?q=`.

### Task 15 — Explore list
`exploration-list.tsx` + rewrite `/explore/page.tsx`: starter input + 3 example chips, create→`/explore/{id}`, list (title/status/updatedAt), empty state.

### Task 16 — Thread + mock roles
`mock-replies.ts`: `AI_ROLE_OPTIONS` (检索/讲解/教练/质疑/编辑/考官/协作/静默), `craftMockReply(role,content,count)` — 2 templates/role, echo `「{slice(0,24)}」`, all end `（模拟回复）`; test. `exploration-thread.tsx` + `/explore/[id]/page.tsx`: turns, role switcher, typing placeholder 600ms, Enter send.

### Task 17 — Promotion panel
`candidate-panel.tsx`: pending candidates, 转笔记→real `createDocument` (body block + `来源：探索「{title}」`)→`setCandidateStatus(promoted,docId)`; 转卡片→mock ReviewCard due now; 转题目→mock PracticeItem (point 01); 拒绝→collapsed. Wire into thread.

### Task 18 — Goals
`goal-list.tsx`/`goal-wizard.tsx`(4 steps, all skippable: scenario→date→subjects(SEED_SYLLABUS)→dailyMinutes 15–120)/`goal-detail.tsx` + routes `/learn/goals[/new]/[id]`.

### Task 19 — Courses (real API)
`course-list.tsx`/`course-create.tsx`/`course-detail.tsx` + routes `/learn/courses[/new]/[id]`; assets via `/api/courses/[id]/assets`, attach via POST memberships (read `service.ts` for exact body), requirement profile (mock `courseProfile:<id>`), guidance mode.

### Task 20 — `/learn` home
`today-plan-view.tsx`/`task-list.tsx`/`risk-section.tsx` + `assessment/status-card.tsx`. Header summary line; task rows (kind icon, 约N分钟, reason sub-line, done/skip/pin, 开始→practice/review); ≤3 StatusCards (≤2 metrics + 1 action + 为什么); trend line; CTA; empty states (no goal → wizard; no tasks → regenerate).

### Task 21 — Practice player
`practice-player.tsx`/`answer-input.tsx`/`verdict-panel.tsx` + `/learn/practice/[itemId]/page.tsx`. MC radio / short input / checkpoint steps (answer `0,2`); hints(max 3)+timer+看答案(assisted); verdict → confidence 1–5 (+errorCause if wrong) → `submitAttempt` (uuid key once per mount, disabled pending, Enter submit) → push result URL with event/task/date params. Correctness: normalize trim/lowercase/全角→半角; checkpoint set equality.

### Task 22 — Result + reason drawer
`result-summary.tsx`, `assessment/reason-drawer.tsx` (为什么 ≤3 mapped zh lines: recent-failure=最近一次作答未答对, low-confidence=作答信心偏低, hint-dependent=提示依赖较高, insufficient-evidence=有效证据不足, consistent-success=近期连续答对且含迁移题, partial-mastery=部分能力稳定，仍有边界; 怎么改善 with 约N分钟; 其他操作: 判断不准 textarea→recordStatusCorrection / 暂时跳过 / 调整优先级→/learn), `/learn/practice/[itemId]/result/page.tsx` (verdict + assisted chip 看了答案，本次不计入有效证据 + status transition badge + next-task CTA).

### Task 23 — Review session
`review-session.tsx` + `/learn/review/page.tsx`: due queue, flip (Space/Enter), grades 忘记/困难/良好/简单 (keys 1–4), progress 第x/N张, finish summary + earliest next due, empty state CTA.

### Task 24 — Settings + diagnostics
`settings-view.tsx` (默认入口 radio → PUT `/api/workspace/preferences`; 指导模式 select; 重置演示数据 confirm→reload) + `diagnostics-panel.tsx` (`<details>`, versions, last 10 events, statuses, plan reasons, 只读 label) + `/settings/page.tsx`.

### Task 25 — Placeholders + polish
`planned-page.tsx` (规划中 badge + 说明 + 替代方案) + `/learn/exams`, `/learn/marketplace`, `/settings/export` pages. Final: 320/768/1440 overflow check, unique-h1 audit, keyboard walkthrough, full gates `lint; typecheck; test; build`. Final report.

## Self-Review (appendix)
- Spec coverage: §三→T7–9; §四→T3–6; §五→T2; §六→T1,T10; §七 every route→T11–25; §八→T20,T22; §九→T10,T25; D8 no-commit honored.
- Type consistency: provider interface (T8) is the single contract consumed by hooks (T9) and all features (T11–24); domain outputs (`StatusResult`,`TodayPlan`,`ReviewState`,`SearchHit`) match contract schemas (T2).
