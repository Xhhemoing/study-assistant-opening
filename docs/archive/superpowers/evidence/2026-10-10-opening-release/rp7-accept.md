# RP7 — release evidence index ACCEPT

**Date:** 2026-10-10 ~00:52 CST (Asia/Shanghai)  
**Accepter:** DATA (Integrator did not self-verify)  
**Status:** **ACCEPT** — RP7 remains `active` (index landing ≠ verified / ≠ prod cutover)

## Scope accepted

- `release-evidence-index.json` + `release-evidence-index.md`
- tipSha `05217a5ceaec7dfe924e3c9783f39bd0db63da51` (40-char)
- quality run `37958795828` / pass rows bound to tip
- Q03 packaging / CLI live restore / MinIO object restore / restore-apply marked **stale** (honest; not tip-bound)
- Q01/Q02/Q04 placeholders `unknown`
- No secrets; node schema ok 9 rows
- Q03/RP5 ledger statuses untouched

## Next

Integrator push of RP7 docs only; Experience HTML board is follow-up.
