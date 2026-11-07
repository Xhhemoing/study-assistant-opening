# RP5 — Browser e2e closed-loop fix (guidance-modes + today-plan)

**Date:** 2026-10-09 ~23:30 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` (working tree; **not committed / not pushed**)  
**Trigger tip:** `8a22308666701bbc2ebfac01bc6aa4a2f81d4aa1` (GHA Browser tests failed)  
**Scope:** test-only (+ evidence md). No apps/web production change.

## Failures addressed (3)

| Spec | Failure | Root cause |
|---|---|---|
| `tests/e2e/guidance-modes.spec.ts:11` | `guidance-mode=advisory` radio missing | 计划自主权 / `GuidanceModePicker` moved to `/settings/advanced` (settings split); test still `goto("/settings")` |
| `tests/e2e/guidance-modes.spec.ts:38` | `getByLabel('开始')` strict mode (14 hits) | Same wrong page: main `/settings` timetable exposes many「开始」labels; picker is on advanced |
| `tests/e2e/today-plan.spec.ts:37` | heading `选择今天的安排` missing after `/learn` | Closed-loop: legacy learn/goals demoted; with `OPENING_RELEASE` middleware redirects `/learn` → `/opening/today`; default playwright.config does **not** set `OPENING_RELEASE`, but conflict wizard is no longer the supported path |

## What changed

### `tests/e2e/guidance-modes.spec.ts`
- Both tests `page.goto("/settings/advanced")`.
- Protected-slot test scopes to `[aria-labelledby="protected-exploration-heading"]` then `getByLabel('开始'|'结束')` / add/remove inside that section.
- Assertions unchanged: advisory → coach → free; add/remove slot `18:30–19:15`.

### `tests/e2e/today-plan.spec.ts`
- Dropped legacy `/learn` 「今日任务」+「跳过」and goals-conflict 「选择今天的安排」 wizard as official path.
- Smoke: after register, `goto("/opening/today")` and assert `heading`「今日学习工作台」, `data-today-loop-links`, nav「今日」, empty start copy.
- Second test: if `isOpeningReleaseEnabled()` assert `/learn` and `/learn/goals/new` redirect to `/opening/today`; else assert opening today directly; never require `选择今天的安排`.

No production UI change (picker already has `aria-labelledby="protected-exploration-heading"`).

## Commands / infra

```bash
# Local (U04 pattern — e2e DB on 5433)
OPENING_RELEASE=0 \
  E2E_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_e2e \
  npm run test:browser -- tests/e2e/guidance-modes.spec.ts tests/e2e/today-plan.spec.ts
```

- Infra: Postgres `5432`+`5433`, Redis `6379`, MinIO `9000` up.
- Default `playwright.config` URL `…5432/aistudy_e2e` absent locally → used `aistudy_opening_e2e` on **5433**.
- Box `.env` / `apps/web/.env.local` have `OPENING_RELEASE=1` (disables public register → 403). Forced `OPENING_RELEASE=0` for this run to match GHA default (webServer.env does not set the flag). First attempt without override: all 4 failed at register 403 — not a product regression from these test edits.

## Result

**4 passed** (1.9m), including both fixed guidance-modes cases and both rewritten today-plan cases.

```
✓ guidance-modes › switches guidance autonomy mode between free, advisory, and coach
✓ guidance-modes › reserves and removes protected exploration time
✓ today-plan › opening today shows closed-loop workbench after register
✓ today-plan › legacy learn paths yield to opening today under closed-loop
```

## Accept (Integrator)

本地已用 `OPENING_RELEASE=0` + `E2E_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_e2e` 跑通上述 4 条 browser e2e；修复仅限两份 spec（settings advanced + 闭环今日页），未改生产 UI、未 commit/push。请 Integrator 纳入 tip 后重跑 GHA Browser。
