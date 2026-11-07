# V2-01 accept — CI lint baseline (`react-hooks/exhaustive-deps` / material-library)

**Date:** 2026-10-11 ~10:23 CST (Asia/Shanghai)  
**Agent:** Integrator ACCEPT (executor)  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Task:** V2-01 — restore quality baseline (GHA Lint rule-definition miss)  
**Verdict:** **ACCEPT**

## Scope of this accept

Accept-only review of the uncommitted product fix claimed in implement evidence. Did **not** implement. No commit / push / stash / reset. Left `docs/superpowers/plans/ai-led-learning-v2/tasks.json` status **proposed** for PM.

## Inputs reviewed

| Artifact | Role |
|---|---|
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-01-ci-lint-implement.md` | Implement claim + local lint results |
| `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-01 | Minimal fix; no blind audit force; re-run real failing check |
| `docs/superpowers/plans/ai-led-learning-v2/tasks.json` V2-01 | Same; acceptance: required release checks not skipped; no forged pass |
| `docs/superpowers/plans/ai-led-learning-v2/ci-observation.txt` | Observed annotation: rule definition not found |

## Diff vs tip `1a4cf46` (stronger review)

**Product files changed (only these two):**

| File | Δ | Review |
|---|---|---|
| `apps/web/src/features/opening/library/use-material-library.ts` | +1 / −1 | `changeSpace` → `useCallback(..., [])`. Body uses only `locked.current` (ref) + React setters (`setSpace` / `setSelected` / `setResult`) — empty deps correct. `useCallback` already imported. |
| `apps/web/src/features/opening/library/material-library.tsx` | +4 / −5 | Destructure `changeSpace: setLibrarySpace`; effect deps `[uploadCourseId, setLibrarySpace]`; **removed** `eslint-disable-next-line react-hooks/exhaustive-deps`. Local UI `changeSpace` wrapper (page/filter reset) unchanged and still calls `library.changeSpace`. |

**Not changed (confirmed clean vs tip):** `package.json`, `package-lock.json`, `eslint.config.mjs`, `.github/workflows/ci.yml`, any other product path.

**Hidden disable scan:** `rg` for `eslint-disable` / `exhaustive-deps` / `react-hooks` in both files → **no matches**. Intentional comment retained (inbound courseId only; stable setter).

**Scope creep:** None. Matches implement claim; no plugin add, no lockfile/audit force, no workflow edit.

## Gates re-run (Accept)

| Gate | Command | Result |
|---|---|---|
| Targeted ESLint (failing path + hook) | `npx eslint apps/web/src/features/opening/library/material-library.tsx apps/web/src/features/opening/library/use-material-library.ts` | **exit 0** (~1.4s) |
| Full lint (CI-equivalent wrapper) | `npm run lint` → `bash scripts/run-heavy.sh eslint .` | **exit 0** (~22s wall) |

Box Node **v20.19.2** / npm **9.2.0**; CI workflow uses Node 22 — same observational note as implement; not introduced by this fix.

## Plan acceptance mapping

| Plan / task criterion | Accept finding |
|---|---|
| Fix missing `react-hooks/exhaustive-deps` rule-definition error from `1a4cf46` Lint | **Met** — disable removed; deps made correct without referencing undefined rule |
| Do not shut off lint / blind `audit fix --force` | **Met** — no config/lockfile/audit change |
| Re-run failing command | **Met** locally (targeted + full `eslint .`) |
| Current SHA required release checks not skipped; no forged pass | **Partial until push** — local lint green on working tree; remote GHA `quality` (Typecheck/tests/build previously skipped on fail) **not** re-executed here because Accept must not commit/push. No forged remote green claimed. |

## Remaining risks (unchanged from implement)

- Remote GHA green requires a later commit/push of these two files, then `quality` job on the new SHA.
- Without `eslint-plugin-react-hooks` in flat config, future incomplete hook deps will not be flagged by CI (optional follow-up, out of V2-01 S scope).
- `changeSpace` empty-deps `useCallback` must gain deps if it later closes over non-ref state.

## Out of scope / not done by Accept

- No commit / push / stash / reset  
- Did **not** change `tasks.json` (left **proposed**)  
- Did not re-run remote GHA  
- Did not add `eslint-plugin-react-hooks` or edit eslint config  

## Diff summary (for PM)

1. **Hook stability:** `changeSpace` in `use-material-library.ts` wrapped in `useCallback` with `[]` so identity stays stable.  
2. **Effect deps:** `material-library.tsx` sync-from-`uploadCourseId` effect now depends on `[uploadCourseId, setLibrarySpace]`.  
3. **Root cause cleared:** invalid `eslint-disable-next-line react-hooks/exhaustive-deps` removed (plugin was never in flat config → CI “rule definition not found”).  
4. **No deps/config churn:** lockfile, `package.json`, and eslint config untouched.

**Verdict: ACCEPT** — product fix correct and locally lint-clean; leave proposed for PM; remote CI pending commit/push outside this Accept slice.
