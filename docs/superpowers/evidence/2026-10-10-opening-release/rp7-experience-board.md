# RP7 Experience — read-only evidence board

**Date:** 2026-10-10 ~00:55 CST (Asia/Shanghai)  
**Owner:** Experience  
**Status:** ready for Integrator / Data Accept (follow-up board only; RP7 index already landed)

## Deliverable
- `docs/superpowers/evidence/2026-10-10-opening-release/release-evidence-board.html`

## Rules kept
- **Read-only** consumer of `release-evidence-index.json` (relative fetch + embedded snapshot fallback)
- **No** `apps/web` / app routes / product UI
- Banner: index ≠ prod cutover; stale ≠ tip-bound pass; no secrets

## How to open
```bash
cd docs/superpowers/evidence/2026-10-10-opening-release
python3 -m http.server 8765
# open http://127.0.0.1:8765/release-evidence-board.html
```

## Accept checklist
- [ ] Board loads tipSha / qualityUrl / checks from JSON
- [ ] `stale` / `unknown` / `pass` visually distinct; tip≠commit noted
- [ ] Artifact links resolve relatively where paths allow
- [ ] No apps/web diff in this slice
