# Package C — Parse honesty + media failure projection (G6+G7) — Integrator ACCEPT

**Date:** 2026-10-10 ~22:30 CST (Asia/Shanghai)  
**Reviewer:** INTEGRATOR (ACCEPT)  
**Branch:** `feat/opening-release`  
**HEAD baseline:** `ea998da` (dirty working tree for Package C only; no commit this turn)  
**Sources:** `holistic-upload-materials-audit-p0-plan.md` § Package C; `holistic-upload-materials-audit-p0-integrator-review.md` (AGREE); `holistic-pkg-c-parse-honesty-implement.md`  
**Verdict:** **ACCEPT**

---

## Gates (re-run; do not trust claim numbers)

```text
cd /workspace/study-assistant-opening
npx vitest run --project unit \
  packages/database/src/repositories/opening-job-failure.test.ts \
  packages/database/src/repositories/opening-jobs.test.ts \
  apps/web/src/features/opening/inbox/upload-state.test.ts \
  apps/worker/src/jobs/parse-media.test.ts
# → Test Files  4 passed (4)
# → Tests  24 passed (24)
# → Duration  ~1.85s

(cd packages/database && npx tsc -p tsconfig.json --noEmit)  # exit 0
(cd apps/web && npx tsc -p tsconfig.json --noEmit)            # exit 0
```

Matches claim (4 files / 24 tests + both tsc clean).

---

## Spot-checks vs claim / plan / AGREE

| Check | Result |
|---|---|
| `failOpeningJob` projects source failed for `parse` **OR** `parse-media` | **PASS** — kind gate is `(kind !== "parse" && kind !== "parse-media")`; privacy/version fences unchanged |
| Unit: parse-media → source failed + version fence | **PASS** — new test in `opening-job-failure.test.ts` |
| `claim` sets source `parse_state=running` for parse/parse-media | **PASS** — after job → running; upload=`uploaded` + version fence + from `not_started`/`queued`/`running` only; race-loss skips source update |
| Unit: claim → source running (parse + parse-media) | **PASS** — three new cases in `opening-jobs.test.ts` |
| Honest UI labels; no fake fail-on-timer | **PASS** — `running` →「原件已保存，正在解析」; `queued`/`not_started` →「…解析排队中」; aged ≥3m via optional `createdAt` →「…解析排队中，可能较慢」; age branch is copy-only |
| Whisper `blocked_not_configured` still `retryable: false` | **PASS** — `parse-media.ts` / `.test.ts` untouched; regression still asserts `retryable: false` |
| MemoryMax unit file untouched | **PASS** — `infra/deploy/aistudy-worker.service` clean; ops note only in implement claim |
| No source-row cancel API / Package A/B/D | **PASS** — dirty product files are only the six C paths (+ tests); `source-row.tsx` clean |
| `tasks.json` / commit / push | **PASS** — `docs/superpowers/plans/opening-release/tasks.json` unmodified; Integrator made no product edits |

### Label wording note (non-blocking)

Claim abbreviated running/queued copy without the shared「原件已保存，」prefix. Product keeps that prefix (consistent with ready/failed/unsupported). Meaningful honesty differentiation matches plan/AGREE.

### Ops / hermes (out of Pipeline product scope per AGREE)

Plan hermes MemoryMax sample-PDF check remains Data/ops follow-up. AGREE: MemoryMax/ops with Data note only — not a code REJECT for this package.

---

## Dirty file list (Package C product + tests)

Modified (uncommitted on tip `ea998da`):
- `packages/database/src/repositories/opening-job-failure.ts`
- `packages/database/src/repositories/opening-job-failure.test.ts`
- `packages/database/src/repositories/opening-jobs.ts`
- `packages/database/src/repositories/opening-jobs.test.ts`
- `apps/web/src/features/opening/inbox/upload-state.ts`
- `apps/web/src/features/opening/inbox/upload-state.test.ts`

Evidence (this accept + prior):
- `holistic-pkg-c-parse-honesty-implement.md`
- `holistic-pkg-c-parse-honesty-accept.md` (this file)
- plan + AGREE + understand companions under same evidence/plan dirs

---

## Boundaries honored

- Integrator made **no** product edits
- Did **not** mark verified in `tasks.json`
- Did **not** commit or push
- Accept covers Package C (G6+G7) code honesty only

## Next

PM may authorize commit for Package C when ready; then Pipeline A server + B server per AGREE sequencing.
