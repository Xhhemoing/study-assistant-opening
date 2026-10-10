# Holistic audit — upload / parse / materials / course link (Understand)

**Date:** 2026-10-10 ~22:30 CST (Asia/Shanghai)  
**Owner:** Pipeline + Experience (audit only)  
**Branch tip:** `feat/opening-release` @ `ea998da`  
**Status:** UNDERSTAND ONLY — no product code changes; no commit/push; `tasks.json` untouched  
**Paula:** does **not** want piecemeal “name one bug → fix one bug”. Wants deep analysis of raised problems, proactive discovery of **same-class** gaps, then one prioritized inventory.

**Evidence base (read, not re-litigated):**  
`docs/superpowers/evidence/2026-10-10-opening-release/` — `upload-parse-gaps-understand.md`, `upload-delete-understand.md`, `stuck-pending-upload-understand.md`, `upload-interrupt-pending-understand.md`, `upload-interrupt-understand-plan.md`, `upload-interrupt-client-represign-p0-plan.md`, `parse-stuck-after-upload-understand.md`, `materials-course-link-understand.md`, plus matching `*-p0-*.md` accept/implement where shipped.

---

## 1. Outcome Paula wants

A **complete, prioritized fix inventory** that:

1. Covers every problem she already named (upload/parse fragility, delete/recovery, interrupt, stuck parse copy, materials UX, course association, AI availability, UI clutter).
2. **Generalizes** each into a class and finds siblings she did not name (other absolute MinIO/S3 browser calls, other terminal states without delete/retry/cancel, dishonest status copy, orphan rows/jobs, association gaps beyond the P0 just shipped, silent AI fallbacks, materials list/filter/bulk/upload→course gaps, parse progress honesty).
3. Yields **batched** fix packages (not one-bug-one-PR) that can be assigned next without waiting for her to name each bug.

---

## 2. End-to-end path map (current tip)

```
beginUpload (POST /api/opening/sources)
  → opening_sources: upload_state=pending, parse_state=not_started
  → ticket.uploadUrl = same-origin stagingUploadUrl(/api/opening/sources/:id/staging)   [3c8cca8]
client PUT staging (cookie auth → putObject(stagingKey))
  → OR interrupt → Paula copy「上传中断…未标记为已上传」+ orphan pending row
completeUpload (POST .../complete)
  → head/magic/digest/validate → completeWithParseJob
  → upload_state=uploaded, parse_state=queued + opening_jobs + opening_outbox
worker dispatchPending → BullMQ → parse | parse-media
  → replaceChunks → ready  |  markParseState(failed|unsupported)  |  failOpeningJob (parse only)
UI: sourceStatusLabel + shouldRefreshSources(~2s while queued/running/not_started)
```

| Step | Key files |
|---|---|
| MIME / sizes | `packages/contracts/src/opening/sources.ts` |
| Client MIME + labels | `apps/web/src/features/opening/inbox/upload-state.ts`, `upload-dropzone.tsx`, `upload-client.ts`, `put-private.ts`, `upload-queue.ts` |
| begin / staging / complete / retry | `source-service.ts`; `app/api/opening/sources/route.ts`; `[id]/staging/route.ts`; `[id]/complete/route.ts`; `[id]/retry/route.ts` |
| Download (still presign) | `source-service.getDownloadUrl` → `presignGet`; `source-viewer.tsx` opens `download.url` |
| Repo / jobs | `packages/database/.../opening-sources.ts`, `opening-job-failure.ts`, `opening-jobs.ts` |
| Workers | `apps/worker/src/jobs/parse-source.ts`, `parse-media.ts`; `runtime/dispatch.ts`, `queue.ts` |
| Materials UI | `library/material-library.tsx`, `material-collection.ts`, `material-batch-actions.tsx`, `material-assign-panel.tsx` |
| Course link | `courses/course-add-materials.tsx`, `course-detail.tsx`; memberships via `material-organization-client` |
| Shell entry | `shell/navigation.ts`; `search/command-palette-model.ts` |

---

## 3. Inventory — FIXED already (tip SHAs)

| SHA | What closed | Class |
|---|---|---|
| `32be749` | Whisper `blocked_not_configured` → `failed` + Chinese + `retryable:false`; honest dropzone (removed formats that only store-as-original) | Parse honesty / media UX |
| `9f47cf1` | Upload-queue failed **清除** (`dismiss`); failed/rejected SourceRow **删除** shortcut | Delete / recovery UX |
| `0489585` | Pending+not_started: explicit **删除** + copy「上传未完成」(was「等待上传完成」) | Stuck pending recovery |
| `3c8cca8` | Same-origin staging PUT route + begin issues `/api/opening/sources/:id/staging`; email import uses `putStaging`; client `resolveUploadPutUrl` | Upload interrupt / MinIO loopback |
| `7dd1ef8` | Docs tip only (`upload-interrupt-client-represign-p0-plan.md`) — **product staging already in `3c8cca8`**; re-presign **not implemented** | Plan for resume/reissue |
| `ea998da` | Sidebar/palette **材料** entry; course page **添加材料**; per-row **归入课程** | Materials discoverability + course link |
| `1f1f3ea` | R2 UI denoise; default Lant/`glm-5.3`; `dailyCapCents` Zod ceiling + catalog merge (stops silent gpt-4o-mini / budget Zod death) | AI availability + clutter |

**Not “fixed” by code (ops):** hermes `aistudy-worker` is active (PM live check); parse-stuck after upload was **Docling slow + MemoryMax=1G**, not “worker disabled”. Unit file still ships `MemoryMax=1024M`.

---

## 4. Inventory — REMAINING gaps

Severity: **P0** blocks daily study loop or recreates Paula’s named pain; **P1** same class / frequent friction; **P2** honesty/polish/debt.

### 4.1 Upload / storage / interrupt

| ID | Symptom | Root cause (file:line / API) | Similarity class | Sev | Owner |
|---|---|---|---|---|---|
| **G1** | 「查看原件」/ Inbox download opens unreachable MinIO host (`127.0.0.1:9000` or internal endpoint) — **same failure mode as staging PUT interrupt** | `source-service.ts` `getDownloadUrl` ~L140 `presignGet`; `download/route.ts` returns that URL; `source-viewer.tsx` L49–54 `href={download.url}` | Absolute S3/MinIO in **browser** | **P0** | Pipeline + Experience |
| **G2** | Materials Inbox upload path does **not** force same-origin rewrite; Strip does | `inbox-panel.tsx` `createUploadClient` omits `resolvePutUrl`; `upload-strip.tsx` L24 passes `resolveUploadPutUrl` | Absolute URL defense-in-depth | **P0** | Experience |
| **G3** | Pending「重试上传」only `retryComplete` — empty staging → policy error; queue resume reuses expired ticket URL | `inbox-panel.tsx` L130–132; `upload-client.ts` resume path; no `POST .../upload-ticket` reissue API | Interrupt recovery / orphan pending | **P0** | Experience + Pipeline |
| **G4** | Begin succeeds then user leaves → permanent `pending`/`not_started` orphans; no TTL/GC to `rejected` | `opening-sources.ts` create; no lease sweeper; lease only used on delete cleanup (`upload_url_expires_at`) | Orphan rows after interrupt | **P1** | Data + Pipeline |
| **G5** | Session queue: stuck `uploading` / `idle` cannot cancel; `dismiss` only `failed` | `upload-queue.ts` L106–112 | States with no cancel | **P1** | Experience |

### 4.2 Parse / worker / status honesty

| ID | Symptom | Root cause | Similarity class | Sev | Owner |
|---|---|---|---|---|---|
| **G6** | Audio/video job **throws** → job=`failed`, source stays `queued` → UI forever「原件已保存，正在解析」 | `opening-job-failure.ts` L21 `if (job.kind !== "parse" …) return true` — excludes `parse-media` | Misleading status vs state machine | **P0** | Pipeline |
| **G7** | Long Docling / OOM: UI never advances; no `parse_state=running` on source; no progress %, no cancel, no “still working / requeue” | `completeWithParseJob` writes `queued` only; `parse-source.ts` AbortController never cancelled from UI; worker unit `MemoryMax=1024M` | Parse stuck honesty / recovery | **P0** | Pipeline + Data/ops |
| **G8** | `.eml` / legacy `.ppt` still → `unsupported` if uploaded via API/email; retryParse refuses unsupported | `parse-source.ts` L50–56; `retryParseWithJob` L203 `parseState !== "failed"` | Fragile parse / no recovery | **P1** | Pipeline |
| **G9** | Images ready with empty text (no OCR); scanned PDF OCR off unless `PARSER_OCR_MODEL_DIR` | `parse-source.ts` IMAGE path; `services/parser/.../__main__.py` `do_ocr=False` | Parse incomplete | **P1** | Pipeline |
| **G10** | Dropzone omits video (`.mp4/.webm`) while contracts + `parse-media` support them | `upload-dropzone.tsx` `openingUploadAccept` vs `packages/contracts/.../sources.ts` | Capability vs entry mismatch | **P2** | Experience |
| **G11** | `media-reader` merges `failed` + `unsupported` into「原件已保存，解析失败」 | `media-reader.tsx` L25–26, L41–42 vs `upload-state.ts` distinct labels | Misleading status copy | **P2** | Experience |
| **G12** | `extract-study-actions` handler registered but **not** in `createQueues` → outbox never consumed | `apps/worker/src/runtime/queue.ts` L19 vs `index.ts` handlers | Orphan jobs / silent stall | **P1** | Pipeline |

### 4.3 Materials library / course association

| ID | Symptom | Root cause | Similarity class | Sev | Owner |
|---|---|---|---|---|---|
| **G13** | Batch bar can **移除课程引用** but **cannot bulk-delete** failed/orphan materials | `material-batch-actions.tsx` — only add/remove membership | Materials manage UX | **P1** | Experience |
| **G14** | Upload flow never offers “归入当前课程”; must upload then assign | Capture/Inbox/Strip have no `courseId` → membership; only post-hoc assign (`ea998da`) | Association gap beyond P0 | **P0** | Experience |
| **G15** | `materialStatus`: pending + queued/running all **processing** — cannot filter “上传未完成” vs “正在解析” | `material-collection.ts` L16–20 | Misleading status / filters | **P1** | Experience |
| **G16** | Delete shortcut still absent for `unsupported` / long `queued` (only failed\|pending) | `source-row.tsx` L38–39 `canDeleteShortcut` | States without delete shortcut | **P1** | Experience |
| **G17** | Organization not ready → assign/batch disabled with little guidance; empty course list looks like “关联坏了” | `use-material-library.ts` / `material-library.tsx` `organizationReady` | Materials manage UX | **P2** | Experience |

### 4.4 AI / settings honesty

| ID | Symptom | Root cause | Similarity class | Sev | Owner |
|---|---|---|---|---|---|
| **G18** | Workspace may still need **budgetConfirmedAt** + positive cap before tutor runs; readiness panel helps but Settings deep link easy to miss after R2 | `ai-settings-service.ts` validateBudgetFields; `ai-readiness.tsx`; R2 moved budget to advanced | Silent / deep AI gate | **P1** | AI + Experience |
| **G19** | `PUBLIC_BASE_URL` fallback `http://127.0.0.1:3000` in `stagingUploadUrl` — wrong host if env unset (Strip rewrite mitigates; Inbox does not) | `source-service.ts` L24–28 | Absolute URL / env footgun | **P1** | Pipeline |

---

## 5. Similar problems Paula did **not** name (explicit)

These were found by generalizing her nine themes against the code:

1. **Browser download still uses absolute MinIO `presignGet`** (G1) — twin of upload interrupt.
2. **Inbox missing `resolveUploadPutUrl`** (G2) while Strip has it.
3. **`failOpeningJob` ignores `parse-media`** (G6) — “正在解析” forever after media crash.
4. **No parse progress / cancel / source `running`** (G7) after Docling/OOM reality on hermes.
5. **No reissue-upload-ticket API + pending retry only complete** (G3) — planned in `upload-interrupt-client-represign-p0-plan.md`, not shipped.
6. **Upload→course association missing from upload surfaces** (G14) even after `ea998da` course-page add.
7. **Bulk delete absent** (G13); filters conflate pending vs parsing (G15).
8. **`extract-study-actions` queue not created** (G12) — same “job never consumed” class as parse-stuck.
9. **Queue cannot cancel in-flight upload** (G5).
10. **No pending TTL/GC** (G4).

---

## 6. Mapping Paula’s nine themes → gaps

| # | Paula theme | Fixed? | Remaining |
|---|---|---|---|
| 1 | Upload parse incomplete / fragile | Partial (`32be749` whisper; dropzone honesty) | G8 eml/ppt; G9 OCR; G10 video entry; G11 media-reader |
| 2 | Failed uploads cannot delete | Mostly (`9f47cf1`, `0489585`) | G13 bulk delete; G16 unsupported/queued shortcut |
| 3 | Stuck pending / not_started recovery | Mostly (`0489585`) | G3 re-PUT/reissue; G4 TTL; G5 queue cancel |
| 4 | Upload interrupt / MinIO loopback /「未标记为已上传」 | Staging PUT fixed (`3c8cca8`) | G1 **download** twin; G2 Inbox rewrite; G19 PUBLIC_BASE_URL |
| 5 | Stuck「原件已保存，正在解析」 | Ops: worker up; Docling/mem | G6 parse-media fail projection; G7 progress/cancel/mem |
| 6 | Materials UI inconvenient | Partial (`ea998da` entry) | G13 bulk; G15 filters; G17 org-ready copy |
| 7 | Materials ↔ courses | Partial (`ea998da` add/assign) | G14 upload-time associate |
| 8 | AI unavailable budget/Zod/default | Schema/default (`1f1f3ea`) | G18 confirm/cap discoverability |
| 9 | UI clutter outside daily loop | R2 (`1f1f3ea`) | Keep denoise; don’t re-clutter with new entry points |

---

## 7. Suggested P0 batch (preview — details in plan doc)

**Package A — Browser never talks to MinIO:** G1 download same-origin proxy + G2 Inbox `resolveUploadPutUrl`.  
**Package B — Interrupt recovery:** G3 reissue ticket + re-PUT retry (queue + materials).  
**Package C — Parse honesty & media fail projection:** G6 `failOpeningJob` + G7 running/progress/cancel or age-based honesty + ops MemoryMax.  
**Package D — Upload→course:** G14 optional course target on Capture/Strip + empty-state CTA.

P1 follow-ons: G4/G5/G8/G9/G12/G13/G15/G16/G18/G19.

---

## 8. Blockers / tree note

- Repo present: `/workspace/study-assistant-opening`, branch `feat/opening-release` @ `ea998da`.
- Working tree: **no dirty product code**; untracked evidence only (`parse-stuck-after-upload-understand.md`, older rp5 note). **No deploy conflict** for writing these docs.
- Live hermes SSH not re-run this audit; parse-stuck addendum (worker active, Docling/mem) treated as given.
- Do **not** flip `tasks.json` verified rows.

---

## 9. Explicit non-actions this turn

No product code, no commit, no push, no hermes mutate, no `tasks.json` edits. Plan draft: `holistic-upload-materials-audit-p0-plan.md`.
