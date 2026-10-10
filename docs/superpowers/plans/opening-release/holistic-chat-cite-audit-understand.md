# Holistic audit — conversation → cite materials / courses / smart retrieval (Understand)

**Date:** 2026-10-10 ~22:42 CST (Asia/Shanghai)  
**Owner:** AI + Experience (audit only; Data/Pipeline where noted)  
**Branch tip:** `feat/opening-release` @ `a837bb8`  
**Status:** UNDERSTAND ONLY — no product code changes; no commit/push; `tasks.json` untouched  
**Paula:** many conversations still cannot / will not cite materials and courses; lack **smart citation**. Wants proactive same-class discovery (not one-bug-one-fix), same style as upload/materials holistic audit.

**Evidence base (read, not re-litigated):**  
- Plans: `03-tutor.md` §T02/T03; `10-media-knowledge.md` §K01/K02/K02a; `ru07-u03-thin-chat.md`; `f02-source-membership-freeze.md`  
- Evidence: `rp4-citations-verified.md`; `k01-course-knowledge.md` / accept; `k02-skill-evidence.md` / accept; `k02a-tutor-policy-verified.md`; materials nav tip `ea998da`; holistic upload packages A–D tip `a837bb8`  
- Do **not** duplicate: materials nav + course link (`ea998da`); upload/materials packages A–D (download proxy, reissue, parse honesty, upload→course)

---

## 1. Outcome Paula wants

A **complete, prioritized fix inventory** that:

1. Explains why study / tutor / assistant chats often answer **without** usable material or course citations.
2. Covers failures across the full path: context attach → retrieval → model cite → program resolve → UI chips → open source at page/chunk.
3. **Generalizes** each failure into a class and finds siblings (ephemeral vs saved, photo vs text, course vs workspace, empty vs wrong cite, download vs viewer).
4. Yields **batched** fix packages (not one-bug-one-PR) assignable next without waiting for her to name each bug.

**Success picture (product):** when the learner is in a course or has ready materials, the assistant **proactively** grounds answers in those materials, returns **clickable citations** (page/chunk), and never silently pretends to be “sourced” when it was not.

---

## 2. End-to-end path map (current tip)

```
UI AssistantView
  selectedSourceIds[]  (manual checkboxes; sticky from last turn / learningAttempt)
  currentPage?          (optional physical page — RU-03)
  courseId on conversation  (set only when creating from learningAttempt; free chat → null)
  privacy: saved | ephemeral
        │
        ├─ saved  → POST /api/opening/turns
        │            tutor-service.submitTurn
        │              authorizedChunksFor(sourceIds)  ← filters chunk.text.trim() only
        │              validatePageSelection
        │              appendSavedTurn + tutor job (sourceIds + sourceVersions snapshot)
        │            worker tutor-turn
        │              privacy exclude → chunksAtSnapshots → selectContext (lexical)
        │              makeTutorInstruction(mode) + provider JSON {text, citedChunkIds[]}
        │              resolveCitations(ids, context)  ← unknown id throws → fail turn
        │              if currentPage set: assertCitationsForPage (all cites must be that page & length>0)
        │              completeTurn(citations)
        │            MessageList chips → sourceDownloadHref (download original, not page viewer)
        │
        └─ ephemeral → ephemeral-service
                         same selectContext / provider
                         citedChunkIds soft-filtered to context
                         UI maps response with citations: []  ← DROPS cites in chat
```

| Step | Key files / APIs |
|---|---|
| Contracts | `packages/contracts/src/opening/tutor.ts` (`TurnInput.sourceIds`, `conversationCreateInput.courseId`); `sources.ts` `citationSchema` (chunkId/sourceId/version/label — **no page**) |
| Context select | `packages/ai/src/opening/context.ts` `selectContext` (term + CJK bigram; preferChunkId/preferPage) |
| Cite resolve | `packages/ai/src/opening/citations.ts` `resolveCitations`; provider outputInstruction in `provider.ts` |
| Durable turn | `apps/worker/src/jobs/tutor-turn.ts`, `tutor-chunks.ts` |
| Submit gate | `apps/web/.../tutor/tutor-service.ts` `authorizedChunksFor`; `page-selection.ts` |
| Ephemeral | `apps/web/.../tutor/ephemeral-service.ts` |
| Mode prompts | `packages/domain/src/opening/tutor-policy.ts` `makeTutorInstruction` / `assertCitationsForPage` |
| UI attach | `assistant-view.tsx`, `source-page-controls.tsx`, `composer.tsx`, `upload-strip.tsx` |
| Cite UI | `message-list.tsx`, `message-model.ts`, `inbox/source-viewer.ts` `sourceDownloadHref` |
| Membership | `material-organization-client.ts`, `course_asset_memberships` — used for library/course link, **not** for tutor retrieval pool |
| Course knowledge (separate) | K01 `opening_course_knowledge` evidenceChunkIds — knowledge page, not chat cite path |

**T02 plan intent (not fully realized):** “First retrieve only authorized selected material/**current course**; selected files outrank other course material”; “general explanations can have no citations but **UI labels them as general**”; keyword retrieval OK (vector deferred).

---

## 3. Inventory — FIXED already (tip SHAs / verified slices)

| SHA / evidence | What closed | Class |
|---|---|---|
| T02 units + `opening-retrieval` integration | Program-owned `selectContext` + `resolveCitations`; workspace isolation; versioned chunks | Retrieval foundation |
| T03 tutor jobs | Durable saved turns; sourceIds + sourceVersions snapshot on turn; polling | Durable path |
| `rp4-citations-verified.md` | ChatMessageView citations chips, version label, mismatch warning, download href helper | Citation **UI shell** |
| K02a / `tutor-policy` | `assertCitationsForPage` when `currentPage` set; mode instructions | Page-sticky **policy** |
| K01 verified | Course knowledge graph with evidenceChunkIds (rebuild/CAS) | Course knowledge **≠** chat cite |
| K02 verified | SkillEvidence + adaptive tutor action chips (clarify/guided/…) | Adaptive **intents**, not cite retrieval |
| `ea998da` | Materials nav + course add/assign shortcuts | Materials discoverability |
| `a837bb8` (A–D) | Same-origin download proxy, reissue upload ticket, parse-media fail honesty, upload→course on Strip | Upload/materials loop (feeds “ready” materials into chat) |
| `1f1f3ea` (prior) | Default model / budget Zod ceiling — reduces silent gpt-4o-mini death | AI availability |

**Still not “smart cite”:** no course-scoped auto pool; no auto-pick materials for a question; no page-deep viewer from chips; ephemeral cites discarded; empty selection answers as “自由交流” without honesty badge when user expected materials.

---

## 4. Inventory — REMAINING gaps

Severity: **P0** blocks daily “ask with materials / see 出处” loop or recreates Paula’s named pain; **P1** same class / frequent friction; **P2** honesty/polish/debt.

### 4.1 Context attach (courseId / sourceIds / membership)

| ID | Symptom | Root cause (file / API) | Similarity class | Sev | Owner |
|---|---|---|---|---|---|
| **C1** | Free assistant chats create `courseId: null`; even with a course conversation, picker lists **all** workspace ready sources, not membership | `assistant-view.tsx` createConversation `courseId: learningAttempt?.courseId ?? null`; `SourcePageControls` uses full `api.listSources()` unless learningAttempt filter | No course-scoped context | **P0** | Experience |
| **C2** | Empty `selectedSourceIds` submits fine → “自由交流”; no force/warn when user is on a course page or has ready course materials | `assistantContextHint` L151–154; `turnInputSchema` allows `sourceIds: []`; tutor-turn skips chunks when empty | Silent answer **without** materials | **P0** | Experience (+ soft AI copy) |
| **C3** | Chat upload (Strip) attaches to course (`a837bb8`) but **does not** add new sourceId into `selectedSourceIds` — still must open 参考资料 and check | `upload-strip.tsx` `onUploaded` → `refreshSources` only; no callback of new ids | Association gap after upload | **P0** | Experience |
| **C4** | Learning-attempt path filters picker to attempt.sourceIds; non-attempt course chat has no membership→picker filter | `assistant-view.tsx` L617 ternary | Course vs workspace scope | **P1** | Experience |
| **C5** | Membership exists (`/api/courses/:id/memberships`) but tutor path never reads it as retrieval pool | T02 “current course” never wired into `submitTurn` / `tutor-turn` | Plan vs code gap | **P0** | AI + Data |

### 4.2 Retrieval / chunks / smart pick

| ID | Symptom | Root cause | Similarity class | Sev | Owner |
|---|---|---|---|---|---|
| **C6** | Sources selected but question terms miss chunk text → `selectContext` returns **[]** → model answers with **zero** chunks (looks like free chat) | `context.ts` L39–41 `score > 0 \|\| preferred`; no course fallback; no “keep top-N of selected even if score 0” when preferPage unset | Silent empty retrieval | **P0** | AI |
| **C7** | Image-only / empty-text ready sources: submit returns `SOURCE_UNAVAILABLE` (“尚无可读正文”) though worker vision path exists | `tutor-service.authorizedChunksFor` L71 `chunk.text.trim()`; ephemeral L116 same filter | Photo cite blocked at gate | **P0** | Experience + AI |
| **C8** | No auto-pick of relevant materials for a question across course membership (or workspace) | Client must pre-select; server never expands `sourceIds` from courseId | Smart cite missing | **P0** | AI + Experience |
| **C9** | Lexical-only retrieval; Chinese synonym / paraphrase misses; vector/embedding deferred (T02 OK) but no measured “enough?” | `selectContext` only | Retrieval quality | **P1** | AI |
| **C10** | Parse “ready” with empty/near-empty chunks (OCR off, image text empty) → unavailable or empty context | Ties to materials G9 OCR; tutor gate text-only | Empty chunks after parse | **P1** | Pipeline + AI |

### 4.3 Model cite / program resolve / fail modes

| ID | Symptom | Root cause | Similarity class | Sev | Owner |
|---|---|---|---|---|---|
| **C11** | Model returns prose / non-JSON → soft degrade `citedChunkIds: []` → answer with **no** chips | `provider.ts` `parseAnswerContent` L75–77 | Model ignores cite instructions | **P0** | AI |
| **C12** | Mode instructions barely require citing (`explain` only “标明材料依据”; hint/listen/think_together silent); outputInstruction allows `[]` for “general” | `tutor-policy.ts` `makeTutorInstruction`; `provider.ts` outputInstruction | Weak cite pressure | **P0** | AI |
| **C13** | Durable path: unknown / hallucinated chunk id → `resolveCitations` throws → **whole turn fails** (harsh); ephemeral soft-filters | `citations.ts` vs `ephemeral-service.ts` L200 | Inconsistent cite validation | **P1** | AI |
| **C14** | With `currentPage` set: empty cites **or** any cite on another page → `PageCitationError` → fail turn (worker English message) | `assertCitationsForPage` requires length>0 and every page===N | Page guard kills useful answers | **P0** | AI + Domain |
| **C15** | No program rule: “if context chunks non-empty and answer claims material facts, require ≥1 valid cite **or** mark general” | Only schema + soft prompt | Honesty gap | **P1** | AI |

### 4.4 Citations UI / viewer / ephemeral drop

| ID | Symptom | Root cause | Similarity class | Sev | Owner |
|---|---|---|---|---|---|
| **C16** | Ephemeral (临时) answers never show 出处 chips even when API returns citedChunkIds | `assistant-view.tsx` L189–190 hardcodes `citations: []` | UI drops refs | **P0** | Experience |
| **C17** | Cite chips download original file only — no jump to physical page / chunk / in-app reader | `citationSchema` lacks page/startMs; `message-list` → `sourceDownloadHref`; SourceViewer is download CTA | No page-deep link | **P0** | Experience + Contracts |
| **C18** | Chip label is `source {uuid} vN page P` — not human filename | `citations.ts` `label()` | Unreadable chips | **P1** | AI + Experience |
| **C19** | When sources were selected but cites empty: UI shows **nothing** (no “一般说明 / 未引用材料”) | T02 promised general label; MessageList only renders when citations.length>0 | Misleading “sourced teacher” look | **P0** | Experience |
| **C20** | K01 knowledge evidence anchors (`#evidence-{chunkId}`) not reused by chat chips | Separate surfaces | Cite UX fragmentation | **P2** | Experience |

### 4.5 Budget / routing / silent AI fallback

| ID | Symptom | Root cause | Similarity class | Sev | Owner |
|---|---|---|---|---|---|
| **C21** | Budget/cap/readiness can block turns; after R2, deep settings easy to miss — answers never happen (not a cite bug, but same “AI won’t ground”) | `ai-readiness.tsx`; budgeted-call reserve | Silent / deep AI gate | **P1** | AI + Experience |
| **C22** | Non-vision model + image-only sources → hard fail `VISION_REQUIRED_MESSAGE`; no auto-fallback to text materials of same course | `tutor-turn.ts` L151–152 | Model routing vs materials | **P1** | AI |

---

## 5. Similar problems Paula did **not** name (explicit)

Found by generalizing “won’t cite / no smart cite” against the code:

1. **Course membership never becomes retrieval pool** (C5/C1) — T02 “current course” dead letter.
2. **Ephemeral path discards citations in UI** (C16) — saved path looks fine in RP4 tests; Paula’s “临时” chats still look uncited.
3. **Empty lexical match → empty context with sources still selected** (C6) — silent ungrounded answer.
4. **`currentPage` + empty/mismatched cites fails the whole turn** (C14) — page sticky becomes a footgun.
5. **Upload-in-chat does not auto-select** (C3) after Package D course attach.
6. **Photo/empty-text blocked at HTTP gate** (C7) while worker vision exists.
7. **No “一般说明” badge** (C19) when cites empty — T02 acceptance gap.
8. **Citation schema cannot deep-link page** (C17).
9. **Create conversation never binds course outside learningAttempt** (C1).
10. **Durable unknown-cite fails turn; ephemeral filters** (C13) — twin inconsistency class.

---

## 6. Mapping Paula themes → gaps

| # | Paula theme | Fixed? | Remaining |
|---|---|---|---|
| 1 | Conversations won’t cite materials | Partial (RP4 chips when cites exist on saved path) | C2 empty selection; C6 empty retrieval; C11/C12 model empty cites; C19 no general label |
| 2 | Won’t cite courses | Membership UX shipped (`ea998da`/`a837bb8`); **retrieval not course-aware** | C1/C4/C5/C8 |
| 3 | Lack smart citation / retrieval | Lexical selectContext only; manual checkboxes | C6/C8/C9; auto-pick package |
| 4 | Cite → open source usefully | Download href same-origin (`a837bb8`) | C17 page/chunk viewer; C18 readable labels |
| 5 | Temporary / some chats never show 出处 | — | C16 ephemeral drop |
| 6 | Page-anchored study | K02a policy present | C14 fail-hard; C7 photo gate |

---

## 7. Suggested P0 batch (preview — details in plan doc)

**Package A — Never silent-ungrounded (ALREADY ACCEPT by Experience @ `0031b85`):** C2 warn/require when course or ready materials exist; C19 general vs sourced badge; C16 ephemeral resolve+show cites.  
**Package B — Course-scoped context pool:** C1 bind courseId; C5 membership→candidate sources; C4/C3 picker filter + auto-select after upload; selected outrank course pool (T02).  
**Package C — Retrieval honesty + soft auto-pick:** C6 never drop all selected when query miss (preferPage/selected fallback); C8 thin auto-pick top materials in course for question (keyword first, no GraphRAG).  
**Package D — Cite resolve + page UX:** C11/C12 stronger cite when context present; C14 soften page guard; C17 citation carries page + viewer deep-link; C7 allow image-only through gate when vision available.

P1 follow-ons: C9/C10/C13/C15/C18/C21/C22/C20.

---

## 8. Blockers / tree note

- Repo: `/workspace/study-assistant-opening`, branch `feat/opening-release` @ **`a837bb8`** (ahead of remote by 1: holistic upload/materials P0).
- Working tree for product code: **clean**. Only unrelated untracked `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md`.
- ABD client files (`assistant-view.tsx`, `upload-strip.tsx`, etc.) are **in tip** — no dirty conflict for writing these docs. Implementers must rebase/merge carefully if ABD accept still in flight on hermes.
- Do **not** flip `tasks.json` verified rows.
- Live hermes “Paula chat won’t cite” repro not re-run this audit; inventory is code+plan grounded.

---

## 9. Explicit non-actions this turn

No product code, no commit, no push, no hermes mutate, no `tasks.json` edits. Plan draft: `holistic-chat-cite-audit-p0-plan.md`.
