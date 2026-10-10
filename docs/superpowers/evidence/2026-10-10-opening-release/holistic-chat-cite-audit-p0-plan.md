# Holistic audit — chat cite / course retrieval P0 batched fix plan (draft)

**Date:** 2026-10-10 ~22:42 CST (Asia/Shanghai)  
**Owner:** Integrator assigns packages (Experience / AI / Data / Pipeline)  
**Branch tip:** `feat/opening-release` @ `a837bb8`  
**Status:** PLAN DRAFT ONLY — **do not implement / commit / push** this turn; **do not** change `tasks.json` verified statuses  
**Companion:** `holistic-chat-cite-audit-understand.md` (gap IDs C1–C22)

---

## Principles

1. **Batches, not one-bug-one-PR.** Each package below is one shippable unit with shared acceptance.
2. Prefer **honesty + course-scoped keyword retrieval** over GraphRAG / vector (T02 ban stands until measured need).
3. **Program owns citations** — model may propose `citedChunkIds`; unknown ids must not fabricate rows; UI must distinguish sourced vs general.
4. Reuse membership APIs (`course_asset_memberships` / material-organization-client) and existing `selectContext` / `resolveCitations` before inventing parallel RAG.
5. Rejected alternatives are explicit so Implementers do not re-litigate.
6. Stay clear of unfinished hermes redeploy of `a837bb8` if ABD accept still open — coordinate Integrator; these packages mostly touch tutor/assistant cite path.

---

## Package A — Never silent-ungrounded (C2 + C16 + C19)

**Severity:** P0  
**Owners:** Experience (UI) + light AI copy if needed  
**Why batched:** Paula’s “won’t cite” often means **no chips + no honesty** — even when the model answered. Fix display and empty-selection honesty first so later retrieval work is visible.

### Files

| Path | Change |
|---|---|
| `apps/web/.../assistant/assistant-view.tsx` | Ephemeral map: resolve `citedChunkIds` → `Citation[]` (client helper or API returns citations); **stop** hardcoding `citations: []` |
| `apps/web/.../tutor/ephemeral-service.ts` (optional) | Prefer return `citations: Citation[]` via `resolveCitations` (filter unknown) so UI does not reimplement |
| `apps/web/.../assistant/message-list.tsx` / `message-model.ts` | When assistant turn has `sourceIds`/context intent but `citations.length===0`, show badge「一般说明（未引用材料）」; when cites present keep「出处：」 |
| `apps/web/.../assistant/composer.tsx` / `assistant-view.tsx` | If conversation has `courseId` **or** course has ready membership materials: soft block or confirm before submit with `sourceIds.length===0` (copy:「当前课程有材料，尚未选入本轮」+ CTA open 参考资料) |
| Tests | ephemeral message shows cite chips when ids valid; empty-cite + selected sources shows general badge; free chat with no course still allows empty sourceIds |

### Approach

1. Ephemeral parity with saved path for cite **display**.
2. Honor T02: general answers allowed, but **labeled** — never look like sourced teacher text.
3. Soft-require materials in course context; do not hard-break free exploration (`courseId==null` and no membership).

### Rejected alternative

- Force every turn to have ≥1 citation — breaks listen / brainstorm; rejected by T02.
- Hide ephemeral privacy mode — privacy is intentional; fix cite mapping instead.
- Client-only fake citations from selected sourceIds without chunk ids — forbidden (fabricated).

### Tests / acceptance

- [ ] Unit: ephemeral assistant message has non-empty `citations` when service returns citedChunkIds in context.
- [ ] Unit: MessageList renders general badge when citations empty and `hadMaterialContext===true`.
- [ ] Unit: course-bound conversation submit without sourceIds surfaces confirm/warn (spy).
- [ ] Manual: 临时对话选材料提问 → 出处 chips visible; 不选材料自由问 → no false「出处」.

---

## Package B — Course-scoped context pool (C1 + C3 + C4 + C5)

**Severity:** P0  
**Owners:** Experience + Data (membership read) + AI (server accept of course pool)  
**Builds on:** `ea998da` / `a837bb8` membership UX — **do not** redo assign UI.

### Files

| Path | Change |
|---|---|
| `assistant-view.tsx` | Allow binding `courseId` on create/resume from course page query / shell context (not only learningAttempt); pass into createConversation |
| `source-page-controls.tsx` + library org client | When `courseId` set: default list = ready sources in **membership**; optional “显示工作区其他材料” expand |
| `upload-strip.tsx` / `assistant-view` | After saved upload: **auto-select** new sourceIds into `selectedSourceIds` (once ready **or** pending-select + enable when ready) |
| `packages/database/.../opening-material-organization.ts` or thin tutor helper | `listReadySourceIdsForCourse(scope, courseId)` |
| `tutor-service.ts` / contracts (optional TurnInput.courseId already on conversation) | On submit: if `sourceIds` empty and conversation.courseId set → **server may** fill from membership ready set (cap 32) **or** 422 with explicit code `COURSE_SOURCES_REQUIRED` — prefer **server fill for smart default** + UI mirror |
| Tests | membership filter; auto-select after strip upload; createConversation persists courseId from course shell |

### Approach

1. T02: “selected outrank other course material” → implement as: explicit `sourceIds` if non-empty; else course membership ready pool (Package C ranks within pool).
2. Do not treat membership as ownership; privacy exclusions still apply.
3. Cap pool size (existing max 32 sourceIds).

### Rejected alternative

- GraphRAG / knowledge-graph nodes as primary chat retrieval — K01 stays separate; T02 ban.
- Auto-select **all** workspace sources — noisy; course-scoped only.
- New parallel “knowledge base chat” product surface — R2 denoise; extend assistant.

### Tests / acceptance

- [ ] Unit/integration: conversation with courseId + empty client sourceIds → server uses membership ready ids (or agreed 422 + UI auto-fill before send).
- [ ] Unit: picker with courseId hides non-members by default.
- [ ] Unit: upload-strip success adds id to selection.
- [ ] Manual: from 课程页 open 助理 → ask without opening checkboxes → answer can cite course materials.

---

## Package C — Retrieval honesty + thin smart pick (C6 + C8, partial C9)

**Severity:** P0  
**Owners:** AI (+ Experience for “已自动选入 N 份” toast)  
**Depends:** Package B pool (or selected sourceIds alone)

### Files

| Path | Change |
|---|---|
| `packages/ai/src/opening/context.ts` | When `sourceIds` selected / pool non-empty and query scores all 0: **fallback** keep preferPage chunks, else first pages / budget-fill from selected sources (deterministic order) — never silently empty if usable chunks exist |
| New thin helper e.g. `packages/ai/src/opening/pick-sources.ts` or worker prelude | Given course pool chunks + query → rank sources by best chunk score; take top K (e.g. 3–8) before selectContext |
| `tutor-turn.ts` / `ephemeral-service.ts` | Wire fallback + optional auto source pick when client sent course-scoped empty/partial selection per Package B contract |
| `assistant-view.tsx` | If server echoes effectiveSourceIds, sync checkboxes / hint「已按问题自动选入 N 份课程材料」 |
| Tests | extend `context.test.ts`; tutor-turn test: non-matching query still gets chunks from selected source; pick-sources ranking fixture ZH/EN |

### Approach

1. Keyword/CJK only — **no** embeddings in this package.
2. Honesty: if fallback used because score==0, still allow cites; optional provenance flag later (P1).
3. Selected files always outrank auto-picked peers.

### Rejected alternative

- Pinecone / vector index for opening release — T02 deferred; measure after keyword honesty.
- Send entire course corpus every turn — blows budget / tokens.
- UI-only “fake select all course materials” without server ranking — wastes context.

### Tests / acceptance

- [ ] Unit: selectContext with query miss + selected chunks → non-empty under budget.
- [ ] Unit: auto-pick returns stable top-K for fixed fixture.
- [ ] Worker unit: turn with course pool and vague question still passes non-empty context to provider (mock).
- [ ] Manual: course with 2 PDFs; ask topic present in one → cite that one preferentially.

---

## Package D — Cite resolve + page / photo UX (C11 + C12 + C14 + C17 + C7)

**Severity:** P0  
**Owners:** AI + Domain + Experience (+ Contracts for citation page fields)  
**Why batched:** Model empty cites, page guard footgun, photo gate, and dead-end download chips are one “smart citation” UX.

### Files

| Path | Change |
|---|---|
| `packages/domain/.../tutor-policy.ts` | Strengthen `makeTutorInstruction`: when materials present, prefer cite supporting chunks; keep general allowed |
| `packages/ai/src/opening/provider.ts` | Tighten outputInstruction: if chunks provided, prefer non-empty citedChunkIds when answer uses them; keep `[]` for pure general |
| `tutor-turn.ts` | Soft-filter unknown cited ids (like ephemeral) **or** drop invalid and continue with valid subset; only fail if policy requires cites and none valid |
| `assertCitationsForPage` / call site | Soften: if `currentPage` set and cites empty → mark general / or inject page-preferred chunks into context only — **do not** fail turn solely for empty cites; if cites exist, filter to page or prefer-page rather than hard throw (keep hard throw only for invented page numbers on **selection** input, already in page-selection) |
| `packages/contracts/.../sources.ts` `citationSchema` | Add optional `page`, `startMs`, `slideLabel` (or structured locator) for UI |
| `citations.ts` | Populate new fields; humanize label with source **name** if deps pass name map |
| `tutor-service` / ephemeral `authorizedChunksFor` | Allow image-only chunks (`imageObjectKey` + empty text) when vision model available; else clear Chinese error (existing) |
| `message-list.tsx` + viewer route | Chip href → in-app source viewer with `?version=&page=` (or hash) — download remains secondary |
| Tests | page guard no longer fails empty cites; image-only submit with vision mock; citation JSON includes page; chip link contains page |

### Approach

1. Program softens resolve; model still cannot invent chunk ids that become rows.
2. Page sticky guides **retrieval preference**, not “answer or die”.
3. Citation → **viewer at page** is the smart-cite payoff Paula will see.

### Rejected alternative

- Remove page citation policy entirely — keep preferPage + selection validation.
- Only improve prompts without UI page deep-link — insufficient for “smart citation”.
- Require OCR before any cite — photo vision path must work (DL8).

### Tests / acceptance

- [ ] Unit: resolveCitations filters unknown when soft mode; durable turn completes with subset.
- [ ] Unit: currentPage set + model returns [] → complete with general (no PageCitationError).
- [ ] Unit: image-only source authorized when supportsVision.
- [ ] Unit/UI: citation chip navigates with page param; label readable.
- [ ] Manual: PDF page 3 selected → answer cites page 3 and chip opens near that page.

---

## P1 backlog (next wave — do not block Package A–D)

| ID | Package sketch | Owner |
|---|---|---|
| C9 | Measured retrieval quality; optional embeddings **after** keyword baseline metrics | AI |
| C10 | OCR / empty-chunk honesty in cite path (ties materials G9) | Pipeline + AI |
| C13 | Align durable/ephemeral cite validation fully (if D soft-filter incomplete) | AI |
| C15 | Structured “must-cite-or-mark-general” post-check when context non-empty | AI |
| C18 | Filename in cite label (if not finished in D) | Experience + AI |
| C20 | Reuse K01 evidence anchors in chat chips | Experience |
| C21 | Surface budget hard-block on assistant when cite path cannot run | AI + Experience |
| C22 | Course text fallback when vision required but model text-only | AI |
| — | Persist effectiveSourceIds on turn for resume sticky after auto-pick | Data |

---

## Sequencing

```
A (honesty + ephemeral cites) ──┐
B (course pool + auto-select) ──┼──► A∥B can start in parallel after Integrator AGREE
C (retrieval fallback + pick) ──┤     C after B (needs pool) or after explicit sourceIds
D (resolve + page/photo UX) ────┘     D ∥ A after contracts cite shape AGREE
         └──► P1 wave
```

- **A** makes existing cites visible and stops fake-sourced silence.
- **B** puts course materials into the conversation without checkbox archaeology.
- **C** stops empty-context answers when materials exist.
- **D** makes cites trustworthy and openable at page; unblocks photo materials.

---

## Explicit non-goals this plan

- No product implementation in the audit turn.
- No commit / push / hermes redeploy authorization claimed here.
- No `tasks.json` verified flips.
- No GraphRAG / Pinecone / new vector infra.
- No restoring R2-removed explore/marketplace chrome.
- No re-opening upload/materials Packages A–D except cite-path consumers of ready sources.

---

## Ready for Integrator

After PM AGREE on Packages **A–D**, assign Implementers; each package writes its own `*-implement.md` / accept under `docs/superpowers/evidence/2026-10-10-opening-release/` (or next dated folder). This file stays the **batch contract**. Coordinate with any remaining ABD hermes accept so `assistant-view.tsx` / `upload-strip.tsx` edits land cleanly on `a837bb8+`.
