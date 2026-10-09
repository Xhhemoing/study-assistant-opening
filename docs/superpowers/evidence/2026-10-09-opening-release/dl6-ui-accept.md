# DL6 UI half accept — Trustworthy practice verdict with learner reference self-check

**Date:** 2026-10-09 ~16:35 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Scope:** Experience UI half only against `docs/superpowers/plans/opening-release/14-loop-closure.md` § DL6.  
**Verdict:** **ACCEPT** (UI half). Data half already accepted earlier (not verified).  
**Browser:** **not run** — do not claim browser pass.  
**tasks.json:** not edited. **verified:** not marked. Ledger close deferred until PM asks after both halves.

## Files reviewed (UI)

**New**
- `apps/web/src/features/opening/learning/reference-check.ts`
- `apps/web/src/features/opening/learning/reference-check-step.tsx`
- `apps/web/src/features/opening/learning/reference-check.test.ts`
- `apps/web/src/features/opening/learning/skill-label-options.ts`
- `apps/web/src/features/opening/learning/skill-label-options.test.ts`

**Changed**
- `apps/web/src/features/opening/learning/attempt-form.tsx`
- `apps/web/src/features/opening/learning/course-view.tsx`
- `apps/web/src/features/opening/client/learning-client.ts` (`getAttempt`) — note: lives under `client/`, not `learning/` as the claim path said
- `apps/web/src/features/opening/learning/eligibility-presentation.test.ts`

**Supporting (read for retestId):** `retest-attempt.ts` / `withRetestSubmit` used by attempt form.

## Data half spot-check (untouched by this UI accept window)

| Artifact | mtime (CST) | Note |
|---|---|---|
| `apps/web/src/app/api/opening/attempts/[id]/route.ts` | ~16:26 | GET deliveredAssistance — data half |
| `packages/database/.../opening-observation-revisions.ts` | ~16:25 | answer-lock + VALIDATION constraints |
| `packages/database/.../opening-learning-evidence-context.ts` | ~16:25 | same-problem revealed rule |
| UI files above | ~16:32–16:33 | later than data; UI half |

UI review did not re-accept data routes/repos; they remain as prior data-half accept.

## Plan criteria (UI-owned)

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Two-step flow: submit original via attempts/[id]/submit; step 2 shows reference then replace via revision API with **same answer** + `referenceCheck`; reason `"对照参考核对"`; answer locked on step 2 | **PASS** | Step 1: `submitAttempt` with `verdictSource: "self_report"`. Step 2: `ReferenceCheckStep` → `reviseObservation(buildSelfCompareRevision(...))`. Answer textarea `readOnly`. Reason constant `SELF_COMPARE_REASON`. Hidden when no `referenceSourceId`. |
| 2 | `buildSelfCompareRevision({ observation, referenceSourceId, choice, page? })` → match/mismatch `reference_checked` + `whole_answer` + method starts `learner_self_compare`; partial → `scope partial`; 看不懂参考 → null / no revision | **PASS** | Implemented + unit-tested. Unclear button calls `onSkip` without request. |
| 3 | Help auto-preselect via `GET …/attempts/[id]` → `deliveredAssistance`; form preselects; user may only raise; uses `getAttempt` | **PASS** | Client `getAttempt`; `preselectAssistance` / `isAssistanceAllowed` / `raiseAssistanceOnly`; options disabled below floor; submit floors again. |
| 4 | Skill label reuse + empty-stem hint that retest won’t generate | **PASS** | `skill-label-options` + datalist/hint in form; amber empty-stem copy in start form + eligibility test asserts it. |
| 5 | DL3 `retestId` wiring preserved on attempt form/submit | **PASS** | `withRetestSubmit(..., retest?.retestId)`; course-view still resolves `?retest=` prefill. |
| 6 | No mastery/稳固 **claims** on touched UI | **PASS** | Only disclaimer copy (“不显示/不表示掌握或稳固”, “不代表掌握”). No mastery/稳固 as a status label. |
| 7 | VALIDATION → HTTP **400** in this repo (not plan’s 422); UI must not depend on 422 | **PASS** | `mapDomainError` maps VALIDATION→400. Reference-check UI keys off 409/403/404/generic message only — no 422 branch. |

## Tests re-run

```text
node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/learning/
→ Test Files  16 passed (16)
→ Tests       158 passed (158)
→ Duration    ~14.08s

./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit
→ exit 0 (no output)
```

Handler/integration for reference self-check **not re-run** for this UI-half accept (data half already green). Browser **not run**.

## Mismatches / observations (non-blocking)

- Claimed path `learning/learning-client.ts` is actually `client/learning-client.ts`.
- Characters 掌握/稳固 appear only in explicit **anti-mastery** disclaimers; treat as product-rule compliant.
- Plan “界面单测” list (lock, unclear skips request, same clientKey, 409 re-read) covered in `reference-check.test.ts` (static markup + builder/helpers); full interactive click flow not browser-tested.

## Recommendation

**ACCEPT** UI half of DL6. Do **not** mark verified; do **not** close ledger until PM consolidates after both halves.
