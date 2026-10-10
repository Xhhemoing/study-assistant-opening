# ACCEPT：upload/materials P1 — Pipeline G12 / G19 / G8 / G9 package

**Date:** 2026-10-10 ~23:49 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `3af5c01` (working tree dirty for multiple P1 waves; this Accept covers **Pipeline G12 / G19 / G8 / G9 only**)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-p1-pipeline-g12-g19-g8-g9-implement.md`  
**Plan:** `holistic-upload-materials-audit-p0-plan.md` § P1 backlog G12 / G19 / G8 / G9; gap inventory `holistic-upload-materials-audit-understand.md` § G12 / G19 / G8 / G9  

---

## Verdict

**ACCEPT** upload/materials P1 **Pipeline G12 / G19 / G8 / G9 package**:

1. **G12** — `createQueues` includes `extract-study-actions` with BullMQ name `opening-extract-study-actions` (handler was already registered in `index.ts`; orphan-queue gap closed).
2. **G19** — `stagingUploadUrl` fail-closed in production when `PUBLIC_BASE_URL` missing/blank after trim; configured base used when set; non-production keeps loopback `http://127.0.0.1:3000`.
3. **G8** — `message/rfc822` (eml) and legacy `application/vnd.ms-powerpoint` mark `unsupported` and return `{ unsupported: true, storedOnly: true }` with no chunks; other non-PDF/PPTX mimes (e.g. audio) remain `{ unsupported: true }` without `storedOnly`.
4. **G9** — Soft checklist key `parser_ocr` + fact `parserOcrReady` from `PARSER_OCR_MODEL_DIR` trim; soft severity never hard-blocks text tutoring; inbox empty-text copy states OCR must be configured for image/scanned pages.

No product edits by this Accept turn, no commit/push/stash/reset. **Pipeline G4 sweep schedule is out of verdict** (already ACCEPTED in `holistic-p1-pipeline-g4-sweep-schedule-accept.md`). AI G18 banner/CTA ownership stays with `holistic-p1-ai-g18-g9-accept.md` (G9 soft-align already cross-checked there).

---

## Gates (re-run 2026-10-10 ~23:48–23:49 CST)

```bash
cd /workspace/study-assistant-opening
npm test -- --project unit \
  apps/worker/src/runtime/queue.test.ts \
  apps/worker/src/jobs/parse-source.test.ts \
  apps/web/src/features/opening/sources/source-service.test.ts \
  packages/ai/src/opening/ai-readiness.test.ts \
  apps/web/src/features/opening/assistant/ai-readiness.test.ts \
  apps/web/src/features/opening/inbox/source-content.test.ts
# → Test Files  6 passed (6)
# → Tests       63 passed (63)
# → vitest 4.1.10
# Note: implement claim was 54 on the same file set; AI G18 wave expanded
# assistant/ai-readiness.test.ts (now 15 alone). Pipeline-core 5 files
# without that assistant file: 48 passed. All green.

npx tsc -p apps/worker/tsconfig.json --noEmit   # exit 0
npx tsc -p packages/ai/tsconfig.json --noEmit   # exit 0
npx tsc -p apps/web/tsconfig.json --noEmit      # exit 0
```

| Gate | Result |
|---|---|
| Vitest same 6-file set (claim **54**; accept **63**) | **Pass** |
| Pipeline-core 5 files (no assistant readiness) **48** | **Pass** |
| `apps/worker` tsc --noEmit | **Pass** (exit 0) |
| `packages/ai` tsc --noEmit | **Pass** (exit 0) |
| `apps/web` tsc --noEmit | **Pass** (exit 0) |

---

## Diff scope vs tip `3af5c01` (this pack only)

| Path | Gap | vs tip |
|---|---|---|
| `apps/worker/src/runtime/queue.ts` | G12 | modified |
| `apps/worker/src/runtime/queue.test.ts` | G12 | **new** (untracked) |
| `apps/web/src/features/opening/sources/source-service.ts` | G19 | modified |
| `apps/web/src/features/opening/sources/source-service.test.ts` | G19 | modified |
| `apps/worker/src/jobs/parse-source.ts` | G8 | modified |
| `apps/worker/src/jobs/parse-source.test.ts` | G8 | modified |
| `packages/ai/src/opening/ai-readiness.ts` | G9 | modified |
| `packages/ai/src/opening/ai-readiness.test.ts` | G9 | modified |
| `apps/web/src/app/api/opening/ai-readiness/route.ts` | G9 | modified |
| `apps/web/src/features/opening/inbox/source-content.tsx` | G9 copy | modified |
| `apps/web/src/features/opening/assistant/ai-readiness*.{ts,tsx}` | G9 soft label / filter (also AI G18 dirty) | modified — G9 soft hooks verified; G18 banner not re-judged |

**Excluded from this verdict (G4 / other waves):** `apps/worker/src/index.ts` sweep interval, `apps/worker/src/jobs/sweep-pending-uploads*`, `packages/database/.../opening-sources*`, Experience materials UI, AI G18 budget CTA product ownership.

---

## Spot-checks (claim / plan acceptance hooks)

| Hook | Result |
|---|---|
| G12: `createQueues` keys include `extract-study-actions` | **Pass** — kind list in `queue.ts` |
| G12: queue name `opening-extract-study-actions` | **Pass** — `createQueue` → `opening-${kind}`; unit asserts `.name` |
| G12: handler still registered | **Pass** — `index.ts` handlers map already had `"extract-study-actions"` |
| G19: production missing `PUBLIC_BASE_URL` throws | **Pass** — `beginUpload` → `stagingUploadUrl`; test rejects `/PUBLIC_BASE_URL is required in production/` |
| G19: production set uses that base (no loopback) | **Pass** — `https://study.example.com/.../staging` |
| G19: non-prod missing → `http://127.0.0.1:3000` | **Pass** — unit with `NODE_ENV=test` |
| G19: blank/whitespace treated as missing (`.trim()`) | **Pass** — product path |
| G8: eml → `unsupported` + `storedOnly: true`, no chunks | **Pass** — `message/rfc822` branch + test |
| G8: legacy ppt same stored-only | **Pass** — same branch + test |
| G8: audio still unsupported **without** `storedOnly` | **Pass** — catch-all unchanged; audio test asserts `{ unsupported: true }` only |
| G9: `parser_ocr` in `AI_READINESS_SOFT_KEYS` | **Pass** — `packages/ai` |
| G9: `parserOcrReady` from `PARSER_OCR_MODEL_DIR?.trim()` | **Pass** — route → `buildAiReadinessItems` |
| G9: detail ok/not + fixHint mentions `PARSER_OCR_MODEL_DIR` / 文字辅导不要求 | **Pass** — Chinese copy locked by unit |
| G9: soft — `isAiReadinessHardBlocker` / `hasAiReadinessHardBlockers` false when OCR alone fails | **Pass** |
| G9: inbox empty-text OCR honesty | **Pass** — 「图片或扫描页在未配置 OCR 时无法提取文字。」 |

### Stronger review (tests green without planned behaviors = REJECT)

| Risk | Assessment |
|---|---|
| G12 test mocks Queue but never checks product kind list | **Rejected risk** — test imports real `createQueues` and asserts exact sorted keys + queue name; omitting the kind fails |
| G19 tests stub `uploadUrl` without calling `stagingUploadUrl` | **Rejected risk** — `beginUpload` / reissue paths call `stagingUploadUrl`; production throw only reachable via that helper |
| G8 eml “storedOnly” only asserted in test doubles, product still catch-all | **Rejected risk** — product MIME or-branch returns `storedOnly: true`; catch-all for other mimes unchanged |
| G9 soft OCR verified only by claim text / hard-blocks tutor | **Rejected risk** — soft set + `isAiReadinessHardBlocker` unit; checklist soft filter; AI accept already re-checked soft-alone empty hard panel |
| Inbox OCR copy test only asserts substring `"OCR"` (would pass old wording) | **Noted weakness** — `source-content.test.ts` does not lock 「未配置 OCR」; **product string present**. Not a REJECT: checklist/builder units lock the readiness copy; copy change is honesty-only |
| G4 interval wiring counted as this pack | **Excluded** — `index.ts` sweep / Data repos not part of verdict |

**Blockers:** none for Pipeline G12 / G19 / G8 / G9.

---

## Per-G notes

### G12
Orphan-queue class: handler existed; `createQueues` omitted the kind so outbox could never enqueue to a live BullMQ queue. One-line kind addition + new unit test is the whole fix. No new migration / handler rewrite.

### G19
Fail-closed only when `NODE_ENV === "production"` and configured base empty after trim. Local/unit paths keep loopback so existing staging tests remain green. Absolute URL footgun for Inbox (no Strip rewrite) is the gap this closes.

### G8
Plan allowed “eml→chunks **or** honest stored-only”; this wave chose stored-only (no full eml extraction). Object stays stored; parse state `unsupported`; return flag distinguishes from generic unsupported audio/etc.

### G9
Soft checklist + env fact only — does **not** enable RapidOCR extraction. Ops still set `PARSER_OCR_MODEL_DIR` on worker for real scanned-PDF text. Soft severity must not appear in hard “AI 为何还不可用” list (asserted via soft keys + AI checklist filter). Shared dirty tree with AI G18; soft OCR not regressed.

---

## Explicitly not accepted here

- Pipeline G4 cron / pending-upload sweep schedule (already ACCEPT)
- Data G4 `sweepExpiredPendingUploadsAll` repository
- AI G18 budget confirm banner / CTA (separate ACCEPT; G9 soft-align cross-checked there)
- Experience G5 / G13 / G15 / G16 materials UI
- Full eml→chunks extraction / hermes OCR deploy / MemoryMax / Docling ops
- commit / push / stash / reset / `tasks.json` verified flips
