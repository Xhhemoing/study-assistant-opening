# Holistic audit — P0 batched fix plan (draft)

**Date:** 2026-10-10 ~22:35 CST (Asia/Shanghai)  
**Owner:** Integrator assigns packages (Experience / Pipeline / Data / AI)  
**Branch tip:** `feat/opening-release` @ `ea998da`  
**Status:** PLAN DRAFT ONLY — **do not implement / commit / push** this turn; **do not** change `tasks.json` verified statuses  
**Companion:** `holistic-upload-materials-audit-understand.md` (gap IDs G1–G19)

---

## Principles

1. **Batches, not one-bug-one-PR.** Each package below is one shippable unit with shared acceptance.
2. Prefer **same-origin / honesty / recovery** over silent fallbacks or fake UI timeouts.
3. Reuse existing APIs (`actions` delete, memberships POST, staging PUT) before inventing parallel paths.
4. Rejected alternatives are explicit so Implementers do not re-litigate.

---

## Package A — Browser never talks to MinIO (G1 + G2)

**Severity:** P0  
**Owners:** Pipeline (download proxy) + Experience (client wiring)  
**Why batched:** Twin of the staging-PUT interrupt Paula already hit; download will fail the same way on hermes.

### Files

| Path | Change |
|---|---|
| `apps/web/src/app/api/opening/sources/[id]/download/route.ts` | Prefer **stream/proxy** (or 302 to same-origin object route) instead of JSON+absolute presign for browser |
| `apps/web/src/features/opening/sources/source-service.ts` | Add `getDownloadStream` / keep `presignGet` **server-only** (worker may still presignGet to MinIO on loopback) |
| New or extend `.../sources/[id]/object/route.ts` (optional) | Authenticated GET → `GetObject` pipe with disposition headers |
| `apps/web/src/features/opening/inbox/source-viewer.tsx` | `href` = same-origin `/api/opening/sources/:id/download?version=` (bytes) **or** keep JSON client but URL must be same-origin |
| `apps/web/src/features/opening/client/api.ts` | If download stays JSON, assert/rewrite URL host; prefer binary route for `<a href>` |
| `apps/web/src/features/opening/inbox/inbox-panel.tsx` | Pass `resolvePutUrl: resolveUploadPutUrl` into `createUploadClient` (parity with Strip) |
| Tests | `download/route.test.ts`; `source-viewer` / `api` / `inbox-panel` tests; assert no `127.0.0.1:9000` in browser-facing payload |

### Approach

1. Browser-facing download must never embed `S3_ENDPOINT` / MinIO loopback.
2. Worker/server `presignGet` for Docling fetch stays OK (runs on hermes where MinIO is reachable).
3. Inbox always rewrites staging PUT via `resolveUploadPutUrl` (defense even if ticket absolute).

### Rejected alternative

- Expose MinIO publicly / `/s3/` rewrite nginx — rejected in prior AGREE (`upload-interrupt-integrator-review.md`); app proxy already proven for PUT.
- “Only document that users must open citations” — citations already use same-origin path helper but API still returns absolute URL to SourceViewer.

### Tests / acceptance

- [ ] Unit: download JSON/stream never contains `127.0.0.1:9000` or raw `S3_ENDPOINT` host.
- [ ] Unit: Inbox client calls `resolveUploadPutUrl` (spy).
- [ ] Manual/hermes: 「查看原件」 downloads without Network to :9000.
- [ ] Staging PUT from materials Inbox still 204 (regression).

---

## Package B — Interrupt recovery: reissue + re-PUT (G3, partial G4/G5)

**Severity:** P0  
**Owners:** Pipeline (reissue API) + Experience (queue + materials retry)  
**Prior plan to absorb:** `docs/superpowers/evidence/2026-10-10-opening-release/upload-interrupt-client-represign-p0-plan.md` (never implemented)

### Files

| Path | Change |
|---|---|
| `packages/database/.../opening-sources.ts` | `reissueUploadTicket` for `upload_state=pending` only; refresh `upload_url_expires_at`; **same source id** |
| `source-service.ts` + `app/api/opening/sources/[id]/upload-ticket/route.ts` (new) | Auth + issue same-origin staging URL |
| `apps/web/.../client/api.ts` | `refreshUploadTicket(sourceId)` |
| `upload-client.ts` / `upload-queue.ts` | Retry: refresh ticket → PUT → complete; never reuse expired `uploadUrl` |
| `inbox-panel.tsx` | Pending retry: if queue holds local bytes for `sourceId`, re-PUT path; else prompt「请重新选择文件」+ keep delete shortcut |
| `put-private.ts` | Keep/enhance HTTP status in error message |
| Optional P1 in same PR or follow-up | Queue cancel for `uploading`/`idle` (G5); soft TTL copy for aged pending (G4 full GC = Data later) |

### Approach

1. One source row, new lease, same-origin staging URL.
2. Materials「重试上传」must not call `retryComplete` alone when staging missing.
3. Align with stuck-pending delete already shipped (`0489585`) — recovery complementary, not competing.

### Rejected alternative

- Auto-delete pending on PUT fail — destroys audit trail; delete stays explicit.
- New begin on every retry — creates duplicate materials (Paula pain).
- Client-only “fake uploaded” — forbidden.

### Tests / acceptance

- [ ] API: reissue on non-pending → 409; on pending → new `expiresAt`, same id, staging path.
- [ ] Queue retry after simulated 403 uses new ticket (mock).
- [ ] Inbox pending without local file shows re-select message; does not call complete-only.
- [ ] PUT interrupt still leaves pending + deletable row.

---

## Package C — Parse honesty + media failure projection (G6 + G7)

**Severity:** P0  
**Owners:** Pipeline (code) + Data/ops (MemoryMax / Docling)  
**Evidence:** `parse-stuck-after-upload-understand.md` addendum (worker active; Docling + 1G pressure)

### Files

| Path | Change |
|---|---|
| `packages/database/.../opening-job-failure.ts` | Project source failed for `kind === "parse" \|\| kind === "parse-media"` (keep privacy/version fences) |
| Matching `*.test.ts` | Media throw → source `parse_state=failed` + error payload |
| `opening-sources.ts` / claim path | On job claim, set source `parse_state=running` (optional but recommended) |
| `upload-state.ts` | Differentiate aged queued (“解析排队中/较慢”) vs running if age known; **do not** fake-fail on timer alone |
| `apps/web/.../source-row.tsx` / inbox | For long `queued`/`running`: show **删除** + **重新解析** only when failed; optional “取消解析” if Pipeline adds cancel job API (P0.1) |
| `infra/deploy/aistudy-worker.service` | Raise `MemoryMax`/`MemoryHigh` (ops; document in evidence) — coordinate with Data |
| Docs | `hermes-deployment.md`: worker memory + Docling concurrency note |

### Approach

1. Close the hole where parse-media crashes leave UI spinning.
2. Make status machine honest (`running` on source) so copy can stop lying.
3. Ops memory bump is part of the package acceptance on hermes, not a silent hope.

### Rejected alternative

- UI-only timeout → mark failed without job truth — masks Docling/OOM; rejected in understand §4 E.
- SQL hand-edit parse_state — high risk; PM-only emergency.

### Tests / acceptance

- [ ] Unit: `failOpeningJob` for parse-media updates source like parse.
- [ ] Unit: claim → source running (if implemented).
- [ ] hermes: after memory bump, sample PDF leaves `queued` within N minutes or surfaces failed with message — record evidence.
- [ ] Whisper blocked path still `retryable:false` (no regression of `32be749`).

---

## Package D — Upload → course association (G14)

**Severity:** P0  
**Owners:** Experience  
**Builds on:** `ea998da` (nav + course add + row assign)

### Files

| Path | Change |
|---|---|
| `capture-dialog.tsx` / `upload-strip.tsx` / assistant upload entry | Optional `courseId` + role (default `reference`) |
| `inbox-panel.tsx` or thin wrapper | After `saved` / complete, if `courseId` → `addToCourse` once |
| `courses/course-add-materials.tsx` / course empty state | CTA「上传并归入本课」→ library `#upload` with query `?courseId=` |
| `material-library.tsx` / `use-material-library.ts` | Read `courseId` query; preselect assign target after upload |
| Tests | upload-with-courseId creates membership; without courseId unchanged |

### Approach

1. Do not force every upload into a course (materials can stay unassigned).
2. When user is **in a course context**, one gesture should attach.
3. Reuse `material-organization-client.addToCourse` — no new membership semantics.

### Rejected alternative

- Restore heavy “知识库” sidebar trees demoted by R2.
- Auto-assign all Inbox uploads to “last course” — surprising; opt-in only.

### Tests / acceptance

- [ ] From course page: upload → membership visible without manual 归入.
- [ ] From global materials: upload without courseId → no membership.
- [ ] Failed upload does not create membership.

---

## P1 backlog (next wave — do not block Package A–D)

| ID | Package sketch | Owner |
|---|---|---|
| G4 | Pending TTL sweeper → `rejected` + optional notify | Data |
| G5 | Queue cancel uploading/idle | Experience |
| G8 | eml→chunks **or** block email-import MIME with honest stored-only at complete | Pipeline |
| G9 | OCR readiness in AI checklist + scanned-PDF copy | Pipeline + AI |
| G12 | Add `extract-study-actions` to `createQueues` | Pipeline |
| G13 | Batch delete (impact + actions) | Experience |
| G15 | Split filters: `incomplete_upload` vs `parsing` | Experience |
| G16 | Delete shortcut for unsupported + aged queued | Experience |
| G18 | Surface budget confirm on assistant when hard-blocked | AI + Experience |
| G19 | Fail closed if `PUBLIC_BASE_URL` unset in production | Pipeline |
| G10/G11/G17 | Video accept alignment; media-reader copy; org-ready empty states | Experience |

---

## Sequencing

```
A (MinIO browser) ──┐
B (reissue/retry) ──┼──► can parallelize A∥B∥D after Integrator AGREE
C (parse honesty) ──┤
D (upload→course) ─┘
         └──► P1 wave
```

- **A** unblocks “I uploaded but can’t open original” (same class as interrupt).
- **B** unblocks “retry does nothing” after interrupt.
- **C** unblocks “正在解析 forever” after media crash / slow Docling honesty.
- **D** unblocks “资料无法关联课程” remaining after `ea998da`.

---

## Explicit non-goals this plan

- No product implementation in the audit turn.
- No commit / push / hermes redeploy authorization claimed here.
- No `tasks.json` verified flips.
- No Q03/Q01 packaging work.
- No restoring R2-removed explore/marketplace chrome.

---

## Ready for Integrator

After PM AGREE on Packages **A–D**, assign Implementers; each package writes its own `*-implement.md` / accept under `docs/superpowers/evidence/2026-10-10-opening-release/` (or next dated folder). This file stays the **batch contract**.
