# Upload-interrupt Understand+Plan — Integrator review

**Date:** 2026-10-10 ~21:44 CST  
**Reviewer:** INTEGRATOR  
**Source:** `upload-interrupt-understand-plan.md`  
**Verdict:** **AGREE**

## Why AGREE

- Message maps exactly to upload-client PUT catch after successful begin.
- hermes `presignPut` → `127.0.0.1:9000` is unreachable from browser; `resolveUploadPutUrl` only rewrites stub hosts; **no** `[id]/staging` route on disk — verified.
- Same-origin staging PUT + always rewrite for browser is the right minimal fix; public MinIO CORS is optional parallel, not a substitute.

## Implement notes (non-blocking)

1. Staging route: auth + workspace ownership; enforce Content-Length/MIME vs begin record; stream/body size caps consistent with upload-policy.
2. `resolveUploadPutUrl`: prefer **always** `stagingPutUrl` for browser tickets (or at least loopback/private hosts); keep tests for both stub and `127.0.0.1:9000` rewrite.
3. Optional: surface PUT status in catch message.
4. P0.1 later: Inbox「重试上传」should resume PUT+complete, not complete-only — call out in implement evidence, don’t block P0.
5. No self-push; PM auth for push/hermes.

## Next

Experience IMPLEMENT → Integrator Accept → PM push/deploy.

---

## Addendum — same-origin `/s3/` (PM / hermes nginx)

**Date:** 2026-10-10 ~21:45 CST  
**Verdict:** **AGREE** as hermes deploy path (alongside or instead of app staging route)

### Why AGREE

- Browser must never PUT to `127.0.0.1:9000`; same-origin proxy under `/s3/` with nginx → MinIO fixes that without changing object semantics.
- Presign host rewrite to public same-origin `/s3/` keeps Signature V4 working if endpoint/signing host stay consistent (forcePathStyle + matching Host/X-Amz headers — IMPLEMENT must prove with a live PUT).
- PM owns nginx on hermes; Experience/Pipeline own client `resolveUploadPutUrl` / env public endpoint rewrite.

### Constraints

1. Pick **one primary** browser PUT path for hermes in this deploy: either `/s3/` rewritten presign **or** app `PUT .../sources/:id/staging` — dual live paths OK only if both tested; prefer documenting the canonical one in hermes-deployment.md.
2. CORS on MinIO alone is **not** enough if URL stays loopback.
3. No self-push; PM deploys nginx + code together.

### Next

Experience/Pipeline IMPLEMENT rewrite + any nginx snippet → Integrator Accept → PM hermes nginx+deploy.
