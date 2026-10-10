# Holistic chat cite audit P0 Plan — Integrator review

**Date:** 2026-10-10 ~22:45 CST  
**Reviewer:** INTEGRATOR  
**Source:** `holistic-chat-cite-audit-p0-plan.md` (companion: `holistic-chat-cite-audit-understand.md`)  
**Branch tip baseline:** `feat/opening-release` @ `a837bb8`  
**Verdict:** **AGREE**

## Why AGREE

- Packages A–D map cleanly to gap IDs: A→C2+C16+C19, B→C1+C3+C4+C5, C→C6+C8 (partial C9), D→C11+C12+C14+C17+C7; P1 backlog holds C9/C10/C13/C15/C18/C20/C21/C22.
- Reuse existing surfaces: `selectContext` / `resolveCitations`, `course_asset_memberships` / material-organization-client, conversation `courseId`, ephemeral soft-filter pattern — no parallel RAG or new vector infra.
- Rejected alternatives are sound: no force-every-turn cite (T02); no hide ephemeral privacy; no client fake citations; no GraphRAG/Pinecone; no auto-select all workspace; no send-entire-corpus; no OCR-gate-before-any-cite.
- Non-goals leave Pipeline idle this wave, leave upload/materials A–D (`a837bb8`) alone except cite-path consumers of ready sources, and leave `tasks.json` / GraphRAG / R2 chrome untouched.
- No package invents fabricated citation rows, weakens privacy exclusions, or dual-edits staging/download proxy paths incorrectly — ABD touch points (`assistant-view.tsx`, `upload-strip.tsx`) are additive (cite display, auto-select after ready) on tip `a837bb8`.

## Implement notes (non-blocking)

1. **PM sequencing overrides plan parallel sketch.** Plan diagram allows A∥B after AGREE and D∥A after contracts; PM dispatch is serial-first:
   1. Integrator **AGREE** this plan (this review).
   2. Experience Package **A** immediately (C2/C16/C19): ephemeral stop hardcode `citations:[]`; empty-cite badge「一般说明（未引用材料）」; soft tip when course has materials but none selected.
   3. After A **Accept**: Experience + Data + AI Package **B** (course membership pool + upload auto-select + courseId bind).
   4. Then AI Package **C** (retrieval fallback + thin smart source pick); Experience Package **D** (cite deep link / page / photo).
   5. Pipeline: **no cite code** this wave.
2. Package A: prefer service-returned `Citation[]` via `resolveCitations`; never fabricate chips from sourceIds alone; free chat (`courseId==null`, no membership) still allows empty sourceIds.
3. Package B: build on `ea998da`/`a837bb8` membership UX — do not redo assign UI; membership ≠ ownership; privacy exclusions still apply; cap 32; explicit `sourceIds` outrank course pool.
4. Package C: keyword/CJK only — no embeddings; selected always outrank auto-picked; depends on B pool (or explicit sourceIds).
5. Package D: soft-filter unknown cited ids / soften empty-cite page guard; keep hard throw only for invented page numbers on selection input; chip → in-app viewer with page (download secondary); image-only only when vision available.
6. Coordinate with any remaining hermes redeploy of `a837bb8` before landing ABD-overlapping client edits; **do not push** this wave until PM says.

## Next

Experience Package **A** IMPLEMENT → Integrator Accept A → Experience+Data+AI Package **B** → AI Package **C** + Experience Package **D** → Integrator Accept remaining → PM push/hermes as authorized. Integrator: AGREE then Accept packages; no product edits; no push.

## Tree note (2026-10-10 ~22:51)

Uncommitted cite plan/evidence and Package A product diffs were wiped when the shared tree returned to clean tip `a837bb8`. PM restoring plan docs; Experience must **re-apply Package A** (or land A+B together) before joint Accept of B. Data may proceed on `listReadySourceIdsForCourse` per Package B contract.
