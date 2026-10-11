# V2-02 Experience half — UI/交互验收线索 ACCEPT

**Date:** 2026-10-11 ~10:15 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ baseline tip `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Owner:** Integrator (ACCEPT) — Experience half only  
**Task:** V2-02（Experience half）— UI/交互验收线索  
**Plan:** `docs/superpowers/plans/ai-led-learning-v2/plan.md` + `tasks.json`（V2-02）  
**Charter:** `docs/plans/2026-10-11-ai-led-learning-v2.md`（Paula Integration constraint）  
**Implement evidence:** `docs/superpowers/evidence/2026-10-11-opening-release/v2-02-experience-ui-acceptance-implement.md`  
**Verdict:** **ACCEPT**

## Scope accepted

Experience / UI·交互验收线索 half only:

- `docs/quality/teaching-v2-evaluation.md` — EX（Paula embed）+ E0–E9；AI content section remains placeholder
- `tests/fixtures/opening/teaching/README.md` — boundary note only；did not author or rewrite AI `unit-rank-nullspace/` content
- No production code (`apps/` / `packages/` clean for this half)

AI fixtures / item bank / answer keys remain **out of slice**. Their WIP under `tests/fixtures/opening/teaching/unit-rank-nullspace/` (incl. `eval-heldout/`) does **not** block this Accept.

## Stronger review (verifiable vs slogan)

| Check | Verifiable criterion found | Result |
|---|---|---|
| EX Paula embed (charter 三点) | EX intro + EX.1–EX.6: same Opening shell; Today/助手/资料/证据 nav; continue/start entry; contracts + Tailwind/lucide; no parallel mastery/score UI; flag on existing release path | **PASS** |
| EX not empty slogans | Each EX row has concrete failure mode (e.g. second client/domain, second mastery bar, isolated marketing page, parallel style system) | **PASS** |
| E0 entry / main area | E0.1–E0.5: no reader-first; material/topic/question entry; desktop main activity; mobile same semantics; no internal jargon on first screen | **PASS** |
| E1 sample flow | E1.1–E1.5: \(T(x,y)=(x+y,0)\) path + 更直观/证明/完整/英文/跳过 + in-context controls | **PASS** |
| E2 same params | E2.1–E2.3: matrix/vector/text one model; no dual invent; a11y/low-motion | **PASS** |
| E3 citation honesty | E3.1–E3.4: sourceId+version+chunk; material vs general badge; structure≠fact; no deleted-source reflux | **PASS** |
| E4 hold-out isolation | E4.1–E4.3 + fixtures README `eval-heldout/` vs lecture/materials; picker listing hold-out = fail | **PASS** (convention); specific forbidden ids deferred to AI half |
| E5 resume | E5.1–E5.4: draft/help/unverified capability; ban fake mastery %; not chat-scroll-only; cross-device | **PASS** |
| E6 autonomy | E6.1–E6.3: no pretest gate; skip keeps drafts; “不要考我” preference | **PASS** |
| E7 failure safety | E7.1–E7.3: no silent draft loss; refresh via persisted job; conflict not last-write-wins | **PASS** |
| E8 honesty | Numbered Paula browser steps incl. EX step 0; states UI mostly not built; `user_browser` stays `pending_user` | **PASS** |
| E9 G1–G8 map | Table maps goals → EX/E* clues including EX | **PASS** |
| AI placeholder honest | `<!-- AI: pedagogical samples / item bank / answer keys -->` + “Experience 不填充本区” still present; no fake item bank by Experience | **PASS** |
| No product code | `git status --short apps/ packages/` empty; HEAD still `1a4cf46…` | **PASS** |
| Non-touches | Did not edit opening-release verified ledger; Experience half did not rewrite AI fixture JSON/md under `unit-rank-nullspace/` | **PASS** |

## What was verified on tree

1. **HEAD** `1a4cf465c86da7f08b6fda3044f9b0f932b80824` (unchanged; no commit).  
2. **`docs/quality/teaching-v2-evaluation.md`:** EX.1–EX.6, E0.1–E0.5, E1.1–E1.5, E2.1–E2.3, E3.1–E3.4, E4.1–E4.3, E5.1–E5.4, E6.1–E6.3, E7.1–E7.3, E8, E9; Paula charter phrases present; AI HTML placeholder intact.  
3. **`tests/fixtures/opening/teaching/README.md`:** ownership boundary; points UX clues to docs/quality; acknowledges AI `unit-rank-nullspace/` + `eval-heldout/` isolation (E4); top-level teaching files = README only for Experience.  
4. **Working tree:** claimed Experience paths present as untracked docs/fixtures; no `apps/`/`packages/` dirty from this half.  
5. **Charter alignment:** Integration constraint (Paula 2026-10-11) three bullets mirrored in EX intro and EX.1–EX.4 M0-sample language.

## Gates

**Docs-only half — no vitest / tsc required or run.**  
Optional manual (re-run at Accept):

```bash
git rev-parse --short HEAD   # 1a4cf46
git status --short -- apps/ packages/   # empty
rg -n "嵌入现有程序|Paula|EX\.[1-6]|AI: pedagogical" docs/quality/teaching-v2-evaluation.md
```

All optional checks above matched.

## Out of slice (do not block Experience Accept)

| Item | Status |
|---|---|
| AI pedagogical samples / item bank / answer keys in evaluation AI section | Still placeholder — AI half |
| `tests/fixtures/opening/teaching/unit-rank-nullspace/**` content completeness | WIP / AI-owned; Experience did not author |
| E4.2 explicit forbidden id list in AI区 | Deferred to AI half (dir isolation documented) |
| M1 UI implementation (V2-10+) | Not claimed; clues only |
| `user_browser=verified` | Explicitly **not** set; remains pending |
| Full V2-02 task (both halves) | Incomplete until AI half Accept |
| Unrelated dirty: V2-03 ADR, plans, rp5-gha evidence, etc. | Not attributed to this Experience half |

## Blockers

None for Experience half.

## Notes

- No commit / push / stash / reset performed.  
- ACCEPT is **not** UI shipped and **not** full V2-02 closed.  
- Separate AI half Accept still required for teaching samples, held-out bank, and answer keys before V2-02 as a whole can close.
