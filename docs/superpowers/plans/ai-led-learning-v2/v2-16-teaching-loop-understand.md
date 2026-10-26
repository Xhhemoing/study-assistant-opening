# V2-16 Understand — 首个AI主讲闭环集成与受控试用

> 2026-10-26 配置更新：矩阵交互已收敛为启用路径，不再读取 `OPENING_MATRIX_TRANSFORM_INTERACTIVE`。解析失败、静态回退与减少动效保护仍保留。以下表格是原阶段记录；现行清单见 [配置控制项盘点](../../../operations/feature-switch-inventory.md)。

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator / QA (executor / Grok Bot)  
**Branch tip:** `74ba005b999c5d8f3c4269b9a3ed1162e6cc3071` (`74ba005`, `feat/opening-release`) — equals PM tip baseline `74ba005` (`feat(opening): V2-15 matrix_transform UI (Experience half)`)  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no product code, no commit / push / hermes / stash / reset / self-ACCEPT / tasks.json verified**)  
**Authority:** Charter `docs/plans/2026-10-11-ai-led-learning-v2.md` G1–G8; `plan.md` §V2-16 (~L645–663); `tasks.json` V2-16; gates `docs/superpowers/plans/opening-release/review-test-gates.md`; sources C01 / R01 / R02 / U01; style refs `v2-15-matrix-transform-*.md` / `v2-14-learning-resume-*.md`  
**Plan ACCEPT owner (PM locked):** **AIstudy Data** (Experience backup) — **not** Integrator (plan author ≠ accepter)  
**Do not conflate:** V2-10 workspace alone ≠ full loop trial; tutor chat / `ConversationResume` ≠ AI-led teaching; reader+chat substitute ≠ acceptance; UX accept ≠ learning_effect proven; V2-17 adaptive choice ≠ this integration slice.

## Restated outcome

Ship the **first internally trialable AI-led teaching loop** on tip-landed slices V2-08…V2-15: real materials + real model path, wired end-to-end behind an internal feature flag, with understandable empty/error states, integration + e2e tests, and UX vs learning-effect recorded **separately**.

Concretely (PM design locks → restatement):

1. **Real path:** real uploaded materials + real model (not fixture-only demo as the trial claim).
2. **Loop flow:** enter → AI teach → local ask (局部追问) → attempt feedback → pause → resume → optional independent problem.
3. **Understandable states:** no course / no model config / budget insufficient / parse incomplete / source withdrawn — each with a real UI or API hook (not silent fail).
4. **Internal flag** via existing release/env process (`OPENING_*` pattern); default off; rollback = turn off flag; keep user content; record failures.
5. **Proposed tests:** `tests/integration/opening-teaching-loop.test.ts` + `tests/e2e/opening-teaching.spec.ts` (**NEW**; both **ABSENT** on tip).
6. **Acceptance:** first trialable milestone **is** AI-led teaching — **not** reader+chat substitute; **no** proven long-term score gain required for internal trial (`learning_effect=unknown` stays honest).
7. **Plan ACCEPT** must be by someone **other than Integrator** — PM locked **Data** (Experience backup).
8. **No Implement this turn** → docs only; no DDL invented.

## Why this exists (gap after V2-08…V2-15)

| Layer | Landed (tip `74ba005`) | Missing / wrong for V2-16 |
|---|---|---|
| Teaching plan / outline | V2-08 `packages/domain/src/opening/teaching-plan.ts` allowlist incl. `matrix_transform` | No single loop harness asserting plan→compile→clientInit |
| Validation honesty | V2-09 `teaching-validation.ts` / `OPENING_TEACHING_VALIDATION_ENABLED` | Loop must not invent “verified correct” from pretty blocks |
| Teaching workspace UI | V2-10 `teaching-workspace.tsx` + `OPENING_TEACHING_WORKSPACE` flag | Flag gates surface; **no** full enter→…→resume e2e / integration |
| Intervention prefs | V2-11 `preference-controls.tsx` + checkpoint prefs | Orthogonal; loop must preserve prefs on pause/resume |
| Local ask commands | V2-12 `command-service.ts` / `block-commands.tsx` / `POST .../commands` | Present; not covered by a teaching-loop integration file |
| Attempt / help evidence | V2-13 attempts + help exposures + activity_id | Feedback path exists; loop test must exercise attempt submit honesty |
| Pause / resume | V2-14 `resume-service.ts` / `resume-card.tsx` / `GET .../resume` + `POST .../checkpoint` + status | Present; not wired into a named loop acceptance script |
| matrix_transform | V2-15 catalog + domain math model + `blocks/matrix-transform.tsx` | Optional viz in loop; **not** required for every trial step |
| Compile jobs | V2-07 `OPENING_TEACHING_COMPILER_ENABLED` + job `compile_teaching_unit` (migr 0055) | Real-model compile path exists; CI may lack secrets for live provider |
| AI readiness / budget | `GET .../ai-readiness` + `ai-readiness-model.ts` hard blockers `daily_budget` / `available_model` | States exist for assistant; teaching loop must **surface** same classes of failure understandably |
| Materials / withdraw | `probeMaterialsAvailability` + `admitLearningSources` + resume `materials` gate | Source withdrawn → `unavailable`/`partial`; parse incomplete via `parse_state` on sources — loop inventory must name hooks |
| No course empty | Library nav 「暂无课程空间」; activity create needs course association | Enter path must fail-soft when no course — not pretend teaching started |
| Integration / e2e specs | `tests/integration/*` (e.g. `opening-adaptive-loop.test.ts` skill evidence — **not** teaching loop); `tests/e2e/opening-*.spec.ts` shell/upload/workflow | **`opening-teaching-loop.test.ts` ABSENT**; **`opening-teaching.spec.ts` ABSENT** |
| Feature flag for M1 trial | Workspace + matrix interactive + compiler + validation flags | No dedicated **loop trial** flag yet — Plan proposes `OPENING_TEACHING_LOOP` |

## PM locks map (must encode in Plan)

| # | PM lock | Inventory anchor | Plan must |
|---|---|---|---|
| 1 | Real materials / real model path | Sources upload + parse jobs; model catalog / `OPENING_MODEL_*`; compile job | Integration can use fixture DB + mocked provider **and** document real-model/`pending` until secrets; e2e may be `pending_user` for live browser |
| 2 | Flow enter→teach→ask→attempt→pause→resume→optional independent | Workspace, commands, attempts, resume, retest/attempt APIs | Map **each** step to tip paths; do not invent new product trees |
| 3 | States: no course / no model / budget / parse incomplete / source withdrawn | Library empty; ai-readiness; budget reserve; source `parse_state`; materials gate | Inventory UI/API hooks; fail-soft copy; no silent success |
| 4 | Internal flag via existing release process | `OPENING_TEACHING_WORKSPACE`, `OPENING_RELEASE`, env pattern | Propose `OPENING_TEACHING_LOOP` (+ `NEXT_PUBLIC_*`); default off; rollback = off |
| 5 | Tests: integration + e2e proposed paths | both **ABSENT** | NEW files only under proposed paths; CI rules unchanged unless tiny hook |
| 6 | UX accept ≠ learning_effect | `tasks.json` evidence_status | Record separately; `learning_effect=unknown` OK for trial |
| 7 | First trialable = AI主讲; not reader+chat; no long-term score proof | Charter G1; acceptance line | Reject chat-only or PDF-reader-as-tutor as ACCEPT |
| 8 | Rollback: flag off; keep content; record failures | Workspace flag precedent | Same; evidence lists failures |
| 9 | Plan ACCEPT ≠ Integrator | PM room lock | **Data** ACCEPT (Experience backup) |
| 10 | Prefer no DDL | Migrations tip **0057** | **DDL: NO** unless real schema gap found (none found) |

## Inventory (paths cited)

### 1. Authority / task

- `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-16 (~L645–663): M1; owner 集成/QA; depends V2-01, V2-08…V2-15; goals G1–G8; scope = real materials/model loop + understandable states + internal flag; reuse `tests/integration`, `tests/e2e`, `.github/workflows/ci.yml`; proposed `opening-teaching-loop.test.ts` + `opening-teaching.spec.ts`; verify agent-isolated DB integration + handler/package typecheck + CI as today; user script accept teaching/cite/skip/resume — pending if no feedback; accept: AI主讲 trialable without long-term score proof; rollback: flag off, keep content, record fails; sources C01, R01, R02, U01.
- `tasks.json` V2-16 — status `proposed`; evidence_status `engineering/real_model=not_run`, `user_browser=pending_user`, `learning_effect=unknown`; relative_size L; owner_role 集成/QA.
- Charter: **G1** AI主讲; **G2** companionship; **G3** materials; **G4** attempt/help honesty; **G5** suitable expression; **G6** evidence honesty; **G7** continuous recovery; **G8** controllable intervention.
- Gates: Implementer ≠ Accepter; Plan author (Integrator) ≠ Plan ACCEPT (Data); no self-verified; no push/hermes by default.

### 2. Loop step → tip modules

| Step | Tip entry points (exist) | Notes |
|---|---|---|
| **Enter** | `POST /api/opening/teaching-activities` (`activity-service.ts`); Today dashboard mount when `isOpeningTeachingWorkspaceEnabled` (`today-dashboard.tsx` + `teaching-workspace-flag.ts`); associate course `POST .../associate-course` | No course → library empty / create blocked — surface honesty |
| **AI teach** | Compile job path (`OPENING_TEACHING_COMPILER_ENABLED`, migr 0055); `packages/ai/src/opening/teaching-compiler.ts`; `generateStatus` → `ready`; `GET .../client-init`; `TeachingWorkspace` + `BlockRenderer` | Usable only when `generateStatus === "ready"` + non-empty blocks (`isTeachingWorkspaceContentUsable`) |
| **Local ask** | `POST /api/opening/teaching/activities/{id}/commands` (`command-service.ts`, `block-commands.tsx`); domain `teaching-commands.ts` | why / rephrase / expand / example / skip / branch / return |
| **Attempt feedback** | `apps/web/src/features/opening/learning/attempt-service.ts`; `POST /api/opening/attempts` (+ submit); help exposures V2-13; resume `actualAttempts` | Do not invent mastery from interaction-only events (G6) |
| **Pause** | `POST .../teaching-activities/{id}/status` → `paused`; checkpoint `POST .../teaching/activities/{id}/checkpoint` | Status enum already has `paused` |
| **Resume** | `GET .../teaching/activities/{id}/resume` (`resume-service.ts`); UI `resume-card.tsx`; gates permission / materials / job | ≠ conversation resume |
| **Optional independent problem** | Attempt / retest surfaces (`attempt-service`, `retest-service`, open problems on LearningResume); intent kinds on activity | Optional — loop ACCEPT must not require independent problem every run |
| **matrix_transform (optional)** | `blocks/matrix-transform.tsx`; `OPENING_MATRIX_TRANSFORM_INTERACTIVE` | May appear in first-unit content; not a hard gate for loop trial |

### 3. Feature flags on tip (pattern)

| Flag | Role |
|---|---|
| `OPENING_RELEASE` | Release access middleware |
| `OPENING_TEACHING_WORKSPACE` / `NEXT_PUBLIC_OPENING_TEACHING_WORKSPACE` | V2-10 workspace surface (default off) |
| `OPENING_TEACHING_COMPILER_ENABLED` | Compiler / compile job |
| `OPENING_TEACHING_VALIDATION_ENABLED` | Validation pipeline |
| `OPENING_MATRIX_TRANSFORM_INTERACTIVE` / `NEXT_PUBLIC_*` | V2-15 interactive vs static |
| **Proposed NEW:** `OPENING_TEACHING_LOOP` / `NEXT_PUBLIC_OPENING_TEACHING_LOOP` | M1 internal trial gate for integrated loop (Plan) |

### 4. Error / empty states inventory

| State | Hook (tip) | Surface today |
|---|---|---|
| **No course** | No `courses` / membership; library `material-space-nav.tsx` 「暂无课程空间」; activity create without course | Enter must show understandable empty — do not open fake ready workspace |
| **No model config** | `ai-settings` availability `missing_key` / `vault_disabled`; `GET /api/opening/ai-readiness` hard `available_model` | Assistant checklist; teaching enter/compile must fail-soft with same class of message |
| **Budget insufficient** | `daily_budget` hard blocker; `BUDGET_CONFIRM_*` in `ai-readiness-model.ts`; budget reserve in tutor/ephemeral | Teaching compile / command provider calls must not pretend success when reserve fails |
| **Parse incomplete** | Source `parse_state` queued/failed/…; chunks absent → `admitLearningSources` VALIDATION | Activity create / resume materials; honesty copy when parse not ready |
| **Source withdrawn** | Privacy exclude / delete / availability; resume `materials: unavailable|partial` + `unavailableSourceIds` | `resume-card` / gates `resolve_material`; do not treat withdrawn blocks as authoritative |

### 5. Tests / CI

- Integration pattern: `tests/integration/opening-fixture.ts` + vitest + agent-isolated DB (`npm run test:integration` in `.github/workflows/ci.yml`).
- E2E pattern: `tests/e2e/opening-*.spec.ts` + `opening-auth.ts` helpers; browser often `pending_user` for product visual.
- **NEW proposed (ABSENT):** `tests/integration/opening-teaching-loop.test.ts`; `tests/e2e/opening-teaching.spec.ts`.

### 6. Related slices (boundaries)

| Slice | Relation |
|---|---|
| V2-08…V2-15 | **Compose** — do not re-implement exclusive trees |
| V2-01 | CI lint baseline dependency |
| V2-07 | Compile jobs — real model path |
| Tutor conversation resume | **OOS** as teaching loop substitute |
| V2-17 | Adaptive teaching choice — **after** V2-16 |
| OpenMAIC / free HTML tutor | Forbidden (V2-10/15 locks) |

## Out of scope (OOS) for V2-16 Understand+Plan

- **No product Implement** of loop tests, flag helper, or UX copy changes this turn.
- **No** commit / push / hermes / stash / reset / self-ACCEPT / flipping `tasks.json` → verified.
- **No** DDL / inventing migration numbers (tip ends **0057**; no schema gap found).
- **No** proving long-term score gain / flipping `learning_effect` to proven.
- **No** replacing AI主讲 with reader+chat “trial”.
- **No** dual-editing Data/Experience/AI exclusive trees in one Implement gate — sequence halves if touch needed.
- **No** Integrator Plan ACCEPT (PM: Data).

## Open decisions for PM / Paula (propose Plan defaults)

1. **Plan ACCEPT agent:** **LOCKED** — **AIstudy Data** (Experience backup). Integrator does not ACCEPT own Plan.
2. **Feature flag name:** Plan default = **`OPENING_TEACHING_LOOP`** (+ `NEXT_PUBLIC_OPENING_TEACHING_LOOP`), default off; trial requires workspace usable surface (either loop implies workspace check, or both on — Plan encodes: loop flag gates trial entry; workspace flag remains product surface).
3. **Fixture materials vs real upload in CI:** Plan default = integration uses isolated fixture sources + **mocked** provider for deterministic engineering; `real_model` stays `not_run`/`pending` until env secrets present; document secret names in Plan open questions.
4. **Independent problem:** Plan default = **optional** step in script; ACCEPT of loop does not require every run to include it.
5. **Who writes copy for empty states:** Plan default = Integrator wires flags/tests + thin fail-soft hooks; Experience owns polished UX strings if copy changes exclusive UI trees — sequence Experience half if needed.
6. **CI secrets for real model:** Confirm whether internal trial CI may hold `OPENING_MODEL_API_KEY` (or catalog) — if no, keep `real_model=not_run` honest.

Escalate only if a Plan default is rejected (except #1 already locked).

## Stronger-review notes (no invented goals)

- Restatement matches `plan.md` §V2-16 + PM brief + tasks.json scope. Goals cited **G1–G8** (full V2-16 set).
- Risk if Implement only turns on workspace flag and demos chat: fails acceptance (not AI主讲).
- Risk if e2e is marked green without user browser: violates `user_browser=pending_user` honesty.
- Risk if learning_effect flipped to proven without evidence: violates G6 / PM lock 6.
- Risk if Integrator self-ACCEPTs Plan: violates PM lock 9 / gates.
- Risk if new tables invented for “loop state”: violates nest-on-checkpoint / DDL NO.
- Risk if dual-edit of `teaching-plan.ts` + `matrix-transform.tsx` in one gate: exclusive-tree violation — sequence.
