# RP7 — Plan: release evidence index (READY_FOR_PM_REVIEW)

**Date:** 2026-10-10 ~00:48 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Owner:** INTEGRATOR (index files); optional **EXPERIENCE** (read-only dashboard consuming JSON)  
**Depends:** RP5 (quality tip already citeable — verified @ `05217a5` / run `37958795828`)  
**Sources:** `15-research-hardening.md` §RP7; research §5.1; `rp7-understand.md`  
**Gate:** **READY_FOR_PM_REVIEW** — do **not** IMPLEMENT until PM / stronger review says go

## Outcome (after IMPLEMENT — not this pass)

A release-candidate evidence index bound to one tip SHA. Auditors reconcile **SHA + index + quality URL**. New in-scope commits require re-running affected checks; old greens become `stale`, never silently inherited.

## Proposed paths

| Role | Path |
|---|---|
| Machine index (primary) | `docs/superpowers/evidence/2026-10-10-opening-release/release-evidence-index.json` |
| Human companion (option A) | `docs/superpowers/evidence/2026-10-10-opening-release/release-evidence-index.md` (generated or hand-kept view of the same rows) |
| Experience board (option B) | Static HTML under evidence (or Experience-owned static asset) that **reads** the JSON — **no** app routes, no `apps/web` product changes |

**Open decision (from Understand):** whether MD companion is required, and whether Experience builds the HTML board in the same IMPLEMENT slice or after JSON lands. Default recommendation for first IMPLEMENT: **JSON + short MD companion**; Experience HTML optional follow-up.

## Schema (each check row)

```json
{
  "commitSha": "05217a5ceaec7dfe924e3c9783f39bd0db63da51",
  "checkName": "gha-quality",
  "runId": "37958795828",
  "environment": "github-actions",
  "completedAt": "2026-10-09T16:44:33Z",
  "result": "pass",
  "artifact": "docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-05217a5-quality-green.md"
}
```

| Field | Rule |
|---|---|
| `commitSha` | Full or unambiguous short SHA of the tip the check claims |
| `checkName` | Stable slug (`gha-quality`, `q03-cli-live-restore`, …) |
| `runId` | GHA run id, local session id, or `null` when unknown |
| `environment` | e.g. `github-actions`, `local-docker`, `minio-live`, `manual` |
| `completedAt` | ISO-8601 instant or `null` if pending/unknown |
| `result` | enum: `pass` \| `fail` \| `pending` \| `unknown` \| `stale` |
| `artifact` | Repo-relative evidence path or run URL; never secrets |

**Index document envelope (proposed):**

```json
{
  "tipSha": "05217a5ceaec7dfe924e3c9783f39bd0db63da51",
  "qualityUrl": "https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37958795828",
  "updatedAt": "2026-10-10T00:48:00+08:00",
  "checks": [ /* rows */ ]
}
```

Credentials / tokens / connection strings **must not** appear in JSON or MD.

## Seed rows (honest — for IMPLEMENT, not created now)

| checkName | commitSha | result | Notes / artifact |
|---|---|---|---|
| `gha-quality` | `05217a5` | `pass` | run `37958795828`; `rp5-gha-05217a5-quality-green.md` |
| `rp5-ci-gate` | `05217a5` | `pass` | bound via RP5 evidence set on tip |
| `q03-packaging-gates` | (prior / unset) | `unknown` or `stale` | path exists under `2026-10-09-opening-release/q03-packaging-gates-run.md` — not re-proven on `05217a5` |
| `q03-cli-live-restore` | (prior / unset) | `unknown` or `stale` | `q03-cli-live-restore-accept.md` — cite path; do not claim tip-bound pass |
| `q03-live-minio-object-restore` | (prior / unset) | `unknown` or `stale` | `q03-live-minio-object-restore-accept.md` |
| `q03-restore-apply` | (prior / unset) | `unknown` or `stale` | `q03-restore-apply-accept.md` |
| `q01-user-acceptance` | — | `unknown` | Q01 still planned; placeholder only |
| `q02` / `q04` | — | `unknown` | planned; placeholders only |

Integrity rule: any row whose `commitSha` ≠ index `tipSha` and `result` was historically green → mark **`stale`** and note re-run required. Do **not** flip Q03 ledger status from this index.

## Approach (IMPLEMENT steps — blocked until review)

1. Create `release-evidence-index.json` with envelope + seed rows above.
2. Optionally write companion `.md` table mirroring the same rows (or generate from JSON).
3. Cross-link `docs/operations/ci.md` and Q03 readiness docs by relative path only.
4. Optional EXPERIENCE: static HTML that fetches/embeds the JSON read-only.
5. Schema-validate with node (no product test suite).
6. Leave Q03 **active**; do not mark Q01–Q04 verified; do not treat index presence as prod-ready.

## Rejected alternatives

- **Complex workflow engine / new orchestrator** — research §5.1 and plan AC explicitly reject; index + honest statuses are enough.
- **Silent inheritance of old tip greens** when HEAD moves — forbidden; use `stale` + re-run.
- **App routes / `apps/web` dashboard** for this slice — out of scope; static evidence only.
- **`npm audit fix --force` or prod cutover** as part of RP7 — out of scope.

## Acceptance checks (mirror `15-research-hardening.md` §RP7)

- [ ] Index template fields complete (`commitSha`, `checkName`, `runId`, `environment`, `completedAt`, `result`, `artifact`); missing → explicit `unknown` / `stale` / `pending`; failures keep run locator.
- [ ] One tip SHA selected; all automation rows either match that SHA or are marked `stale` with re-run note.
- [ ] Tip’s GHA quality URL + `runId` / `result` written (seed: `37958795828` / `pass` @ `05217a5`).
- [ ] Q03 / RP5 / Q01-related evidence paths listed as placeholders or existing paths; **no** ledger status change for Q03/RP5 from this task beyond RP7 itself.
- [ ] Regression: plan merge or index file existence ≠ “gate passed” ≠ “prod cutover OK”.

**Acceptance (plan wording):** release candidate can be checked as one SHA + one index + one quality URL; in-scope new commits cannot silently reuse old all-green.

## Test (IMPLEMENT only — no product tests)

```text
node -e "
const fs = require('fs');
const idx = JSON.parse(fs.readFileSync(
  'docs/superpowers/evidence/2026-10-10-opening-release/release-evidence-index.json','utf8'));
const allowed = new Set(['pass','fail','pending','unknown','stale']);
const fields = ['commitSha','checkName','runId','environment','completedAt','result','artifact'];
if (!idx.tipSha || !idx.qualityUrl || !Array.isArray(idx.checks)) process.exit(1);
for (const row of idx.checks) {
  for (const f of fields) if (!(f in row)) { console.error('missing', f, row); process.exit(1); }
  if (!allowed.has(row.result)) { console.error('bad result', row.result); process.exit(1); }
}
console.log('ok', idx.checks.length, 'rows @', idx.tipSha.slice(0,7));
"
```

No vitest / browser / Docker for RP7 itself.

## Out of scope (locked)

- Production cutover; force-push; workflow engine.
- Marking Q01–Q04 verified; closing Q03; Docker-for-Q03 work.
- Implementing index in this Plan-only pass.
- Modifying `apps/web`.

## Ledger / evidence this pass

| Action | Detail |
|---|---|
| RP7 status | `planned` → **`active`** |
| Evidence appended | `rp7-understand.md`, `rp7-plan.md` |
| Q03 | remains **active** (untouched) |
| IMPLEMENT | **blocked** until PM / stronger review |

## Gate

**READY_FOR_PM_REVIEW** — stop here. Do not create `release-evidence-index.json` / `.md` / HTML until review says go.
