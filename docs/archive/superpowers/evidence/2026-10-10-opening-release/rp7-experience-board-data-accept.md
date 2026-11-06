# RP7 Experience board — DATA ACCEPT

**Date:** 2026-10-10 ~00:56 CST (Asia/Shanghai)  
**Accepter:** DATA (reports to Experience; Integrator already ACCEPTed separately)  
**Status:** **ACCEPT**

## Scope reviewed
- `release-evidence-board.html` — read-only consumer of `release-evidence-index.json`
- `rp7-experience-board.md` — open instructions
- Compared against on-disk `release-evidence-index.json` (+ short MD companion)

## Data accept criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Read-only (no write to index/ledger/apps) | **PASS** — only `fetch("./release-evidence-index.json", { cache: "no-store" })` + embedded parse; no POST/PUT/write APIs |
| 2 | Index completeness consumption | **PASS** — meta shows tipSha / qualityUrl / updatedAt; table columns cover commitSha, checkName, runId, environment, completedAt, result, artifact; nulls → "—" |
| 3 | Honest pass/stale/unknown | **PASS** — banner (index ≠ prod cutover / Q03 verified); distinct pills; tip≠commit marked `(≠ tip)`; summary counts tip-bound pass only; embedded matches disk (2 pass / 4 stale / 3 unknown @ tip `05217a5`) |
| 4 | No secrets in HTML/MD | **PASS** — no tokens/keys/creds; only public GHA URL + evidence paths |
| 5 | Static evidence page, not apps/web | **PASS** — under evidence dir; mentions of apps/web are “do not edit”; worktree apps/web dirty is DL11, unrelated |
| 6 | Works with on-disk index shape | **PASS** — embedded snapshot == disk JSON; HTTP smoke 200 for HTML+JSON |

## Gaps / notes (non-blocking)
- Embedded snapshot freezes at page authoring time; live freshness needs local HTTP + Reload (footer documents this).
- Board landing ≠ RP7 verified ≠ prod cutover; ledger stays `active`.

## Chinese note for Experience
看板只读消费索引通过 Data 验收：字段齐全、pass/stale/unknown 诚实、无密钥、不碰 apps/web。请用本目录 `python3 -m http.server` 打开以读最新 JSON；内嵌快照仅作 file:// 回退。
