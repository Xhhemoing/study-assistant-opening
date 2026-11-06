# Q03 accept — ESLint ignore Python venv directories

**Date:** 2026-10-09 ~23:41 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `3c764b1` (+ eslint ignore, uncommitted at accept time)  
**Workspace:** `/workspace/study-assistant-opening`  
**Owner:** INTEGRATOR (AIstudy Integrator)  
**Verdict:** **ACCEPT yes** — ignore-only eslint config change; `npm run lint` exit 0.  
**Q03 status:** remains **active** (**not verified**).

## Diff verified (ignore-only)

`eslint.config.mjs` — under the existing ignores block, after `.tmp/**`:

- Comment: `// Python virtualenvs (e.g. services/parser/.venv) are not project source.`
- `"**/.venv/**"`
- `"**/venv/**"`

No vendor edits; no product/app source changes in this slice.

## Integrator re-run (local)

| Command | Result |
|---|---|
| `npm run lint` | **exit 0** (~25s wall; heavy-task wrapper) |

## Ledger

- Append this file to Q03 `evidence` in `tasks.json`
- Q03 **status remains `active`** — do **not** mark verified on ACCEPT alone
- Packaging-gates / nodocker evidence **not** included in this accept commit (narrow eslint slice)

