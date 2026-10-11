# V2-02 AI half — 教学样本 / fixtures / 评测标准 ACCEPT

**Date:** 2026-10-11 ~10:19 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ baseline tip `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Owner:** Integrator (ACCEPT) — AI half only  
**Task:** V2-02（AI half）— 秩与零空间可核查教学单元与评测样本  
**Plan:** `docs/superpowers/plans/ai-led-learning-v2/plan.md` + `tasks.json`（V2-02）  
**Implement evidence:** `docs/superpowers/evidence/2026-10-11-opening-release/v2-02-ai-teaching-fixtures-implement.md`  
**Experience half:** `v2-02-experience-ui-acceptance-accept.md` — already **ACCEPT**  
**Verdict:** **ACCEPT**

## Scope accepted

AI / teaching-fixtures half only:

- `tests/fixtures/opening/teaching/unit-rank-nullspace/` — materials, goals, correct/errors, lecture allowlist, eval-heldout denylist + ISOLATION, anomaly cases, manifest, symbols
- `tests/fixtures/opening/teaching/README.md` — AI inventory appended; Experience Boundary / Isolation / Related retained
- `docs/quality/teaching-v2-evaluation.md` — AI §1–7 filled; Experience EX + E0–E9 **unchanged in place**
- No production code (`apps/` / `packages/` clean)

## Stronger review (verifiable)

| Check | Criterion | Result |
|---|---|---|
| Counts claim | 5 sources / 14 chunks / 12 correct / 10 errors / 15 heldout / 9 anomaly; countable 60 | **PASS** (14+12+10+15+9=60); manifest agrees |
| materials | 5 `SRC-RN-*.md` + sources-index 5 entries, sourceIds SRC-RN-01…05 | **PASS** |
| chunks | 14 `chunkHints` across 5 sources | **PASS** |
| examples / errors | EX-RN-01…12 (all `exposureClass=lecture`); ERR-RN-01…10 | **PASS** |
| goals / activities | G-RN-01…06; activity-outline 7 activities | **PASS** |
| heldout ⊆ denylist | HO-RN-01…15 == `deniedProblemIds` (bijection) | **PASS** |
| heldout ∉ allowlist | no HO-RN-* in allowlist JSON; ∩ sources/examples/errors = ∅; `explicitlyExcluded` has `eval-heldout/` | **PASS** |
| allowlist ⊆ lecture materials | authorizedSourceIds = SRC-RN-*; authorizedExampleIds = EX-RN-* | **PASS** |
| sourceId refs | goals/examples/errors/outline SRC-* refs ⊆ sources-index | **PASS** |
| ISOLATION.md | forbids teaching retrieval / tutor context; points denylist + allowlist; “number swap ≠ transfer” | **PASS** |
| heldout dimensions | concept 3 / explain 3 / compute 6 / transfer 2 / delayed 1 | **PASS** (coverage present) |
| anomaly categories | same_page_cross_source, wrong_formula, missing_page, renamed_skill, audio_only_video×2, citation_id_not_truth, variant_id_not_transfer, fake_mastery_percent | **PASS** (plan verification themes covered) |
| JSON parse | all 10 unit JSON files `json.load` OK | **PASS** |
| EX / E0–E9 intact | All EX.1–EX.6 and E0–E9 section headers + row IDs present before AI header; Paula「嵌入现有程序 / 非旁路」language present | **PASS** |
| AI section filled | §1–7 content/eval standards, sample list, human check, joint-accept notes; “Experience 不填充本区” retained | **PASS** |
| README merge | Experience Boundary kept; AI inventory appended | **PASS** |
| No product code | `git status --short -- apps/ packages/` empty; HEAD still `1a4cf46…` | **PASS** |
| Ledgers | Did **not** edit `opening-release/tasks.json` or `ai-led-learning-v2/tasks.json` | **PASS** (left to PM) |

## Sanity script (Integrator re-run)

Re-validated locally (Python): JSON load, counts vs manifest, heldout↔denylist bijection, heldout absent from allowlist, SRC-* ref integrity, EX/E markers, apps/packages clean, HEAD tip.

**RESULT: ALL CHECKS PASSED** (94 checks, 0 failures)

## What was verified on tree

1. **HEAD** `1a4cf465c86da7f08b6fda3044f9b0f932b80824` (unchanged; no commit).  
2. **Fixtures** under `unit-rank-nullspace/` match implement inventory and claim counts.  
3. **Hard isolation:** held-out problemIds live only under `eval-heldout/` + denylist; lecture allowlist is materials + lecture examples only.  
4. **Eval doc:** Experience EX/E0–E9 still present and structurally intact; AI section documents content standards, independent gold location, E4 cross-ref, and honest non-claims (no real-model / browser / learning-effect).  
5. **Plan acceptance (V2-02):** “首单元有可回查依据和独立于生成内容的评价标准；未曝光题不进入教学检索” — met for AI half.

## Gates

**Docs/fixtures-only half — no vitest / tsc required or run.**  
Optional re-check at Accept (all matched):

```bash
git rev-parse HEAD   # 1a4cf465c86da7f08b6fda3044f9b0f932b80824
git status --short -- apps/ packages/   # empty
# heldout ⊆ denylist; heldout ∉ allowlist; counts 5/14/12/10/15/9 → 60
```

## Out of slice (do not block AI Accept)

| Item | Status |
|---|---|
| Real-model teaching generation quality | **not_run** |
| Paula browser UI (`user_browser`) | **pending_user** (Experience E8 clues only) |
| Learning effect | **unknown** |
| Production teaching retrieval enforcement (V2-06+) | Fixtures + policy JSON only; runtime not in this slice |
| `tasks.json` status → accepted/verified | Left for PM; eval doc §7 + Accept preference |
| M1 UI implementation | Not claimed |

## Blockers

None for AI half.

## Joint V2-02 note

| Half | Evidence | Verdict |
|---|---|---|
| Experience (UI/交互验收线索) | `v2-02-experience-ui-acceptance-accept.md` | **ACCEPT** |
| AI (teaching fixtures + eval AI section) | this file | **ACCEPT** |

**V2-02 joint ACCEPT ready.** Both halves green: UI acceptance clues (EX/E0–E9) + first-unit fixtures with independent eval standards and held-out isolation. Full V2-02 task can be closed by PM when ledger update is authorized; Integrator did **not** mutate `tasks.json`.

## Notes

- No commit / push / stash / reset performed.  
- ACCEPT is **not** UI shipped, **not** real-model pass, **not** learning-effect known.  
- opening-release verified ledger untouched.
