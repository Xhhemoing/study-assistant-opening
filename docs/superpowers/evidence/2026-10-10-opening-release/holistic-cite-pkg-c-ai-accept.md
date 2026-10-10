# ACCEPT：Holistic cite Package C — AI half (retrieval fallback + thin smart pick) — re-ACCEPT after REJECT

**Date:** 2026-10-10 ~23:26 CST (Asia/Shanghai)  
**Reviewer:** Integrator re-ACCEPT (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `acceadb` (working tree dirty for Package C AI + Experience C; no Integrator commit)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-cite-pkg-c-ai-implement.md` (REJECT re-fix §)  
**Prior REJECT:** this file (overwritten; was REJECT ~23:24 CST)  
**Plan:** `holistic-chat-cite-audit-p0-plan.md` § Package C (AI / server half only)

---

## Verdict

**ACCEPT** AI half of cite Package **C**. Prior REJECT blockers are closed:

1. Worker `tutor-turn` no longer top-Ks any `sourceIds.length > 6`. Pick runs only on submit-path via `shouldAutoPickSources` (ephemeral + tutor-service). Worker comment documents that persisted turn ids are never re-narrowed.
2. Regressions exist and assert the contract: explicit large selection stays intact on worker (7 sources → 7 in provider context) and on tutor-service (explicit 7 unchanged; empty+pool>K picks ≤6 with best match first).

Focused gates green: **6 files / 138 tests**; tsc clean for `packages/ai`, `packages/contracts`, `apps/web`, `apps/worker`. No product edits by this Accept turn; no commit/push. Experience UI half remains **out of this slice** (separate Experience accept already on tree).

---

## Prior blockers — closure

| # | REJECT blocker | Closure |
|---|---|---|
| 1 | `tutor-turn.ts` top-K whenever `allowedSourceIds.length > 6`, including explicit client selections | **Closed.** Diff vs `acceadb`: worker only adds a comment; no `pickSourceIds` / `shouldAutoPickSources` import or call. `rg` shows pick gated solely in ephemeral + tutor-service behind `shouldAutoPickSources(clientEmpty, pool>K)`. |
| 2 | Missing regression: explicit large selection not narrowed; tutor-service Package C pick cases | **Closed.** `tutor-turn.test.ts`: “explicit large sourceIds are not top-K narrowed” asserts `sourceIdsInContext.size === 7`. `tutor-service.test.ts`: auto-pick empty+pool>8 → ≤6 best-first; explicit 7 → unchanged + pool helper not called. |

### Stronger review (suite must not pass while still over-picking)

- Worker regression sends **7** query-matching sources with `maxContextCharacters = 50_000`. If pick(K=6) still ran before `selectContext`, provider context would have **6** distinct `sourceId`s and the test would fail. Pass ⇒ no worker over-pick.
- Tutor-service explicit case asserts persisted `sourceIds === explicit` (length 7) and `listReadySourceIdsForCourse` not called — cannot pass if pick narrowed or pool-fill ran on non-empty client.
- Helper unit: `shouldAutoPickSources([S1], pool7) === false`; `shouldAutoPickSources([], pool7) === true`.

---

## Gates (re-run 2026-10-10 ~23:26 CST)

```bash
cd /workspace/study-assistant-opening
./node_modules/.bin/vitest run \
  apps/worker/src/jobs/tutor-turn.test.ts \
  apps/web/src/features/opening/tutor/tutor-service.test.ts \
  packages/ai/src/opening/context.test.ts \
  packages/ai/src/opening/pick-sources.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-service.test.ts \
  packages/contracts/src/opening/contracts.test.ts
# → Test Files  6 passed (6)
# → Tests       138 passed (138)
# Duration ~4.47s

(cd packages/ai && npx tsc -p tsconfig.json --noEmit)          # exit 0
(cd packages/contracts && npx tsc -p tsconfig.json --noEmit)   # exit 0
(cd apps/web && npx tsc -p tsconfig.json --noEmit)             # exit 0
(cd apps/worker && npx tsc -p tsconfig.json --noEmit)          # exit 0
```

| Gate | Result |
|---|---|
| Vitest 6 files / 138 tests (implementer claim match) | **Pass** |
| `packages/ai` tsc --noEmit | **Pass** (exit 0) |
| `packages/contracts` tsc --noEmit | **Pass** (exit 0) |
| `apps/web` tsc --noEmit | **Pass** (exit 0) |
| `apps/worker` tsc --noEmit | **Pass** (exit 0) |

---

## Spot-checks (Package C AI acceptance)

| Hook | Result |
|---|---|
| `selectContext` query miss + usable chunks → preferPage / deterministic budget-fill, never silent empty | **Pass** |
| `pickSourceIds` stable top-K=6 (clamp 3–8); ZH/EN; zero-score still fills K | **Pass** |
| `shouldAutoPickSources` only when client empty **and** pool > K | **Pass** |
| Ephemeral: empty client + courseId → fill → pick → echo `effectiveSourceIds` | **Pass** |
| Ephemeral: explicit non-empty client → omit `effectiveSourceIds` | **Pass** |
| Ephemeral: vague query + selected chunks → non-empty provider context | **Pass** |
| Contracts: optional `effectiveSourceIds` / optional `courseId` | **Pass** |
| Runtime wires `listReadySourceIdsForCourse` into ephemeral deps | **Pass** |
| Tutor-service submit: pick after B fill when client empty + pool > K | **Pass** (+ Package C tests) |
| Tutor-service: explicit large selection never narrowed | **Pass** (regression) |
| Worker: vague query still non-empty context | **Pass** |
| Worker: no pick / no re-narrow of explicit large selections | **Pass** (regression + code audit) |
| Experience UI unchanged **in this AI half** | **Pass** for AI claim files; Experience C reviewed separately |
| 未推 / no commit by Integrator | **Pass** — tip still `acceadb` |

---

## Files in scope (AI half vs `acceadb`)

| Path | Role |
|---|---|
| `packages/ai/src/opening/context.ts` (+test) | score helper + miss fallback |
| `packages/ai/src/opening/pick-sources.ts` (+test) | thin smart pick (untracked new) |
| `packages/ai/src/index.ts` | exports |
| `packages/contracts/src/opening/tutor.ts` (+contracts.test) | optional `effectiveSourceIds` / `courseId` |
| `apps/web/.../ephemeral-service.ts` (+test) | fill/pick/fallback + echo |
| `apps/web/.../tutor-service.ts` (+test) | pick after B fill; Package C regressions |
| `apps/web/.../runtime.ts` | ephemeral course-pool dep wire |
| `apps/worker/.../tutor-turn.ts` (+test) | comment only (no pick); explicit-large + vague regressions |
| claim + this accept evidence | |

## Explicitly not accepted here

- Experience Package C UI (`assistant-view`, toast/sync helpers, `course-source-selection`) — **out of slice**; see `holistic-cite-pkg-c-experience-accept.md`
- Package D cite resolve / page / photo
- Embeddings / Pinecone / GraphRAG
- commit / push

---

## Notes

- Implementer REJECT re-fix claimed 6 files / 138 vitest — **reproduced exactly**.
- Dirty tree also contains Experience C edits and unrelated evidence; AI re-Accept did not re-review Experience product.
- Integrator did not commit, push, stash, reset, or edit product code.
