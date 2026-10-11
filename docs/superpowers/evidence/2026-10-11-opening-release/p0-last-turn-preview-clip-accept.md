# P0 accept — lastTurnPreview max 280 clip

**Date:** 2026-10-11 (Asia/Shanghai / CST)  
**Agent:** Integrator ACCEPT (executor / AIstudy Integrator Accepting Data)  
**Baseline tip HEAD:** `aa3f81ba26b244f13a6f10979a69c2912ed7345d` (`feat/opening-release`)  
**Implement evidence:** `docs/superpowers/evidence/2026-10-11-opening-release/p0-last-turn-preview-clip-implement.md`  
**Verdict:** **ACCEPT**  
**Priority:** Ahead of V2-04 merge (PM). No hermes / commit / push / stash / reset. Did not touch `0053_*`.

## Scope

Paula Zod `lastTurnPreview` too_big (max 280). Data clipped SQL + map; PM加严 required (1) map `slice(0,280)` aligned with SQL LEFT intent, (2) emoji/surrogate-pair regression or documented behavior. Integrator re-verified independently after Data follow-up.

## Files under review

| Path | Role |
|---|---|
| `packages/database/src/repositories/opening-conversations.ts` | SQL `LEFT` + `clipLastTurnPreview` map |
| `packages/database/src/repositories/opening-conversations-preview.test.ts` | Unit / Zod / emoji regression |
| `packages/contracts/src/opening/conversations.ts` | `lastTurnPreview: z.string().max(280).nullable()` (unchanged; contract) |

Schema file `packages/database/src/schema/opening-conversations.ts` exists but was **not** part of this change.

## Verification matrix

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | SQL `LEFT(..., 280)` wraps **full** CASE (deleted-source msg **or** `coalesce(t.text,'')`), not only ELSE | **PASS** | Diff: was `CASE … ELSE LEFT(t.text, 280) END`; now `LEFT(CASE … END, 280)` in `listSummaries` subquery |
| 2 | Map uses `clipLastTurnPreview` = JS `slice(0, LAST_TURN_PREVIEW_MAX)` with `LAST_TURN_PREVIEW_MAX = 280` | **PASS** | `lastTurnPreview: clipLastTurnPreview((r.last_turn_preview as string \| null) ?? null)` |
| 3 | Map clip aligned with Zod (JS UTF-16 code units); SQL LEFT = PG characters | **PASS** | Comment on helper documents PG char vs Zod code-unit; map is authoritative for contract. Implement follow-up § documents same |
| 4 | Emoji / surrogate-pair regression | **PASS** | Test `clips Postgres-char LEFT residue that exceeds Zod via emoji surrogate pairs`: 280× `😀` → JS length 560 fails schema; after clip length 280 parses |
| 5 | `0053_*` / V2-04 migration tree untouched by this P0 | **PASS** | P0 diff only `opening-conversations.ts` (+new preview test + implement md). `0053_opening_teaching_activities.sql` remains untracked V2-04 artifact; md5 `878e49c1bb366552121911a7f875e67c` unchanged across accept |
| 6 | Contract still `max(280)` | **PASS** | `packages/contracts/src/opening/conversations.ts` L12 |

## Tests re-run by Integrator (not fabricated)

```text
npx vitest run packages/database/src/repositories/opening-conversations-preview.test.ts --project unit --reporter=verbose

✓ returns null for nullish
✓ keeps strings within max
✓ clips oversize previews so conversationSummarySchema.parse succeeds
✓ clips Postgres-char LEFT residue that exceeds Zod via emoji surrogate pairs

Test Files  1 passed (1)
Tests       4 passed (4)
```

Implement Commands block still says “# 3 passed”; Follow-up correctly claims 4 after emoji case. Integrator confirms **4 passed**.

## Soft notes (non-blocking)

1. Implement header Commands stale (“3 passed”) vs Follow-up / live run (4) — cosmetic evidence drift only.
2. `slice(0, 280)` on odd boundaries can theoretically split a surrogate pair; with even 280 and 2-unit emoji the regression lands on a pair boundary. Acceptable for Zod compliance; optional future grapheme-safe clip not required for this P0.
3. Tip remained `aa3f81b`; working-tree change only. No hermes.

## Hard-rules compliance

- No commit / push / stash / reset  
- No migrate apply  
- No modification of `0053_*`  
- No hermes  

## Verdict

**ACCEPT** — SQL full-CASE LEFT, map `clipLastTurnPreview`/`slice(0,280)` Zod-aligned, emoji/surrogate regression green (4/4), 0053 untouched.
