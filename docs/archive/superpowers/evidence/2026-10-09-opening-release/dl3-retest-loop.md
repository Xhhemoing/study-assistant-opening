# DL3 Retest loop (data + UI) — agent-owned checks accepted

Verifier: AIstudy Integrator (not the implementer). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `13-daily-loop-gaps.md` § DL3

**Data half**
- Ordinary observations enqueue `retest-scan:<courseId>:<observationId>` + outbox in the same transaction; observations with `retestId` do not scan again.
- Worker loads stem prompts via `readLatestStemPromptsBySkill` when payload omits `promptsBySkill`; prefix `隔天重做原题（先不看之前的答案）：`; skills without stems produce no proposal.
- `taskItemSchema.retest` projection; `listTasks` joins retest activity; `planDay` skips retests with `recommendedAt` after planning day end (does not write `due_at`).

**UI half**
- Today page `RetestProposals` reuses `ReviewCard` + `createReviewActions` (accept/discard, single request, no auto-retry).
- Due retest selection shows 「开始补测」 → `/opening/courses/<courseId>?retest=<candidateId>#course-practice` with prefill; `attempt-form` submits `retestId`; success only re-reads (server sets done).
- Queue grouping reads `task.retest.recommendedAt`; client `taskListSchema` uses `taskItemSchema` so projection is not stripped.

## Verification (Integrator re-run 2026-10-09)

- unit: day-planner + retest-candidate + learning/ + planning/ + assistant/ — **40 files, 379 passed**.
- integration: `opening-retest-scan-enqueue.test.ts` + `opening-retest-task-bridge.test.ts` — **8 passed** (`OPENING_TEST_DB=1` @ `127.0.0.1:5432/aistudy_opening_test`).
- handler: `opening-learning-attempts.test.ts` + `opening-retest-accept.test.ts` — **13 passed**.
- `tsc` contracts/domain/database/web/worker — exit 0.

## Not run

- Browser / e2e full walk (观察→提议→接受→到期补测→作答→完成). Plan/`AGENTS.md` leave browser to the user; same follow-up pattern as DL2/DL5.

## Ledger

- `tasks.json` DL3 → `verified` with this evidence path. No commit.
