# F02 freeze — source course membership (RU-01 / materials)

Status: **freeze bump verified** (2026-09-14, see §9). Contract freeze originally adopted by opening-lead 2026-09-13. Do **not** treat remaining F03/I01 resolver gaps as blocked by F02 — F02 contracts are green; F03/I01 sequencing per §4.
Owner: materials (RU-01 freeze doc) + INTEGRATOR (Zod / interfaces).
Branch: `feat/opening-release` @ `E:\Project\study-assistant-opening`

## 0) Ruling (adopted)

- `SourceRecord` / `sourceRecordSchema`: **no `courseId`**. Course association is membership-only (`course_asset_memberships` + link/unlink inputs).
- Keep `sourceCourseLinkInputSchema` / `sourceCourseUnlinkInputSchema` (sourceId + courseId + clientKey).
- STOP F03/I01 code: F03 depends on F01+F02; F01 still planned; F02 not verified this wave.
- materials maintains this freeze doc + contract alignment notes only until the gate clears.

Verified on disk: `packages/contracts/src/opening/sources.ts` `sourceRecordSchema` has no `courseId` (link/unlink schemas still carry `courseId`).

## 1) Repro (aligned with evidence E03) — verified 2026-09-13

**Symptom.** `createCourseMembershipRepository(...).addAssetMembership({ assetType: 'source', ... })` throws
`CourseMembershipError(code=VALIDATION, message='Asset type not yet membership-backed: source')`
before any membership INSERT.

**Root locus (measured, not guessed).**
- `packages/database/src/repositories/course-membership.ts` `resolveAssetWorkspace` (~L250–299) only resolves `document` / `block` / `card`; every other `AssetType` (including `source`) hits the VALIDATION throw.
- Contracts already allow the type: `packages/contracts/src/assets.ts` `assetTypeSchema` includes `source`.
- Course HTTP exists: `GET|POST /api/courses` (`apps/web/src/app/api/courses/route.ts`). Membership create: `POST /api/courses/[id]/memberships`.
- Second gate (auth adapter): `addMembershipForPrincipal` in `apps/web/src/features/auth/service.ts` types `body.assetType` as literal `"document"` only — even a working resolver would be blocked at the API layer until this widens under the same security checks.

**Failing command (E03 probe; no DB writes).**

```bash
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createCourseMembershipRepository } from './packages/database/src/repositories/course-membership.ts';
const w='00000000-0000-4000-8000-000000000001';
const c='00000000-0000-4000-8000-000000000002';
const s='00000000-0000-4000-8000-000000000003';
let reads=0;
const sql=async (parts,...values)=>{
  reads++;
  const q=parts.join('?').replace(/\s+/g,' ').trim();
  if(q.startsWith('SELECT id FROM workspaces')) return [{id:w}];
  if(q.startsWith('SELECT * FROM courses')) return [{id:c,workspace_id:w,
    title:'Synthetic mathematics',slug:'synthetic-math',description:'',
    schema_version:1,created_at:new Date(0),updated_at:new Date(0),archived_at:null}];
  throw new Error('Unexpected SQL in read-only probe: '+q);
};
await assert.rejects(createCourseMembershipRepository(sql).addAssetMembership({
  workspaceId:w,courseId:c,assetType:'source',assetId:s,role:'core',visibility:'private'
}),error=>{
  assert.equal(error.code,'VALIDATION');
  assert.equal(error.message,'Asset type not yet membership-backed: source');
  console.log('RU-PROBE membership:',error.code,error.message);return true;
});
assert.equal(reads,2);
console.log('RU-PROBE scope: actual repository + fake SQL, 2 reads, 0 writes, no database connection');
JS
```

**Observed result (this machine).**
`RU-PROBE membership: VALIDATION Asset type not yet membership-backed: source`
`RU-PROBE scope: actual repository + fake SQL, 2 reads, 0 writes, no database connection`

## 2) Contract freeze (into F02 / `interfaces.md` + `packages/contracts/src/opening/`)

### 2.1 Identity vs membership (must freeze)

| Surface | Rule |
|---|---|
| `SourceRecord` identity | workspace-scoped only. **No `courseId` on the source row / object key / upload ticket.** |
| Course link | **Only** `course_asset_memberships` rows with `asset_type='source'`. |
| Conflict to resolve in F02 | `interfaces.md` §1 currently still shows `courseId: string \| null` on `SourceRecord` while the prose says course association is membership-only. **Freeze: drop `courseId` from `SourceRecord` / `sourceRecordSchema`.** Optional denormalized `courseIds` on list DTOs may be computed from memberships later — not stored on source identity. |

### 2.2 Restricted ownership resolver (repository contract)

Keep existing error codes. Extend only `resolveAssetWorkspace`:

```ts
// Pseudocode for F03/I01 implementation — freeze the behavior now
async function resolveAssetWorkspace(assetType: AssetType, assetId: string): Promise<string> {
  assertUuid(assetId, 'assetId');
  assertAssetType(assetType);
  if (assetType === 'document') { /* existing library_documents */ }
  if (assetType === 'block') { /* existing library_blocks */ }
  if (assetType === 'card') { /* existing cards */ }
  if (assetType === 'source') {
    // Table name lands in F03 (`opening_sources` / createOpeningSourceRepository).
    // SELECT workspace_id FROM <opening_sources> WHERE id = $assetId [AND not deleted]
    // NOT_FOUND if missing; never invent a workspace.
    // Do NOT relax CROSS_WORKSPACE_REFERENCE / WORKSPACE_MISMATCH.
  }
  throw new CourseMembershipError('VALIDATION', `Asset type not yet membership-backed: ${assetType}`);
}
```

**Security non-negotiables (do not weaken).**
- Still require `ensureWorkspace(workspaceId)`.
- Still reject `course.workspaceId !== input.workspaceId` → `WORKSPACE_MISMATCH`.
- Still reject `assetWs !== input.workspaceId` → `CROSS_WORKSPACE_REFERENCE`.
- Still rely on unique index `(course_id, asset_type, asset_id)` → `DUPLICATE_MEMBERSHIP` on same course; **same source in two courses is allowed** (different `course_id`), **does not copy** the source bytes / row.
- Other types (`practice-item`, `artifact`) stay VALIDATION until explicitly membership-backed.

### 2.3 Associate / revoke API contract

Reuse existing membership repository methods; widen the HTTP/auth adapter.

| Op | Repository | Proposed HTTP | Body / notes |
|---|---|---|---|
| Associate | `addAssetMembership` | `POST /api/courses/:courseId/memberships` | `{ assetType: 'source', assetId, role, visibility, sortOrder? }` — widen principal helper beyond `"document"` only |
| Update | `updateAssetMembership` | (existing if exposed; else same POST semantics not required for AC03) | role / visibility / sortOrder |
| Revoke | `removeAssetMembership` | `DELETE /api/courses/:courseId/memberships` with body or `DELETE .../memberships/:assetType/:assetId` | **No HTTP DELETE today** — freeze path + auth action `membership.delete` for I01/U01 |
| List | `listCourseAssets` | `GET /api/courses/:courseId/assets` | Must return `source` memberships after associate (may omit heavy SourceRecord fields) |
| Cross-device read | `listCourses` + list assets | `GET /api/courses` then assets | Same workspace principal cookie / session on another device |

**Auth.** `assertAuthorized(principal, "membership.create" | "membership.delete" | "course.read", { workspaceId, courseId })` — principal workspace only; no body-supplied `workspaceId` / `ownerUserId`.

**Zod (F02).** Add / keep under `packages/contracts/src/opening/` (or shared assets):
- `assetTypeSchema` already includes `source` (keep).
- `courseAssetMembershipInputSchema` `.strict()` with `assetType` enum including `source`, UUID `assetId`, role/visibility enums matching repository.
- `sourceRecordSchema` **without** `courseId`.

## 3) Acceptance AC03 (freeze wording)

Empty account → create course → upload source → associate → visible on another session/device in same workspace; cross-workspace associate rejected; same source linked to two courses without duplicating the source object.

| Check | Pass signal | Fail signal |
|---|---|---|
| Create course (empty owner) | `POST /api/courses` → 201, course in `GET /api/courses` | 4xx / missing from list |
| Upload source | opening sources begin+complete (F03) → `SourceRecord` in workspace, `courseId` absent | Source carries courseId or lands in wrong workspace |
| Associate | `POST .../memberships` with `assetType:'source'` → 201 membership row | Still `VALIDATION Asset type not yet membership-backed: source` or auth type reject |
| Cross-device same workspace | Second session lists course + membership for same `source` id | Missing membership / different source id (copy) |
| Cross workspace | Associate source from other workspace → `CROSS_WORKSPACE_REFERENCE` / 403 mapped | Silent attach |
| Two courses, one source | Two memberships, one `source` id; bytes/row not duplicated | Second associate copies source or unique-collides globally |

## 4) Sequencing (explicit)

1. **This wave:** contract freeze only — this doc + Zod/interfaces alignment (SourceRecord without courseId; link/unlink retained).
2. **Gate:** F01 green AND F02 verified/reviewed.
3. **Then F03:** Persist opening_sources (+ jobs/budget per plan) so ownership resolver has a table.
4. **Then I01 (membership connection):** 
esolveAssetWorkspace('source'), widen auth membership types, wire link/unlink HTTP to membership (no source-row course ownership).
5. **U01:** opening UI paths that call those APIs (separate owner).
## 5) Out of scope for this draft

- Parse / Docling / formula fidelity (RU-03).
- Citation physical page rules beyond noting membership ≠ parse.
- Chat UI, mastery product, plan rewrites.
- Weakening VALIDATION for unimplemented asset types.

## 6) Verification commands (for later green; freeze expects red today)

```bash
# E03 red today (must stay documented until I01)
node --import tsx --input-type=module <<'JS'
# …same probe as §1…
JS

# After F02 contract land (INTEGRATOR)
node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/contracts.test.ts

# After I01 (not now)
# guarded integration: associate source + cross-workspace reject + dual-course reuse
```


## 7) Implemented (RU-01 resolver slice — Fiona continue 2026-09-13)

- 
esolveAssetWorkspace('source') reads opening_sources.workspace_id; security checks unchanged.
- Migration/schema:  016_opening_sources.sql, schema/opening-sources.ts (no course_id column).
- Auth: ddMembershipForPrincipal accepts source; 
emoveMembershipForPrincipal + DELETE /api/courses/[id]/memberships.
- Verify: 
ode node_modules/vitest/vitest.mjs run --project unit packages/database/src/repositories/course-membership.source.test.ts → 4/4 pass.
- Not in this slice: F03 jobs/budget/fixture, signed upload, opening link-course HTTP (membership POST/DELETE is the associate/revoke path).

## 8) Implemented (upload completion + course read projection — 2026-09-13)

- alidateStoredUpload boundary: pps/web/src/features/opening/sources/upload-policy.ts
- createOpeningSourceRepository.complete: pending→uploaded on exact bytes/sha256/mime match; replay idempotent; SourceRecord has no courseId
- Course read projection: listCourseAssets attaches item.source from membership join (no courseId on SourceRecord)
- Verify: `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/sources/upload-policy.test.ts packages/database/src/repositories/opening-sources.test.ts packages/database/src/repositories/course-membership.source.test.ts` → 3 files / 11 tests passed
- Still not: Docling/jobs/outbox, real S3 signed PUT, opening HTTP link-course routes

## 9) Freeze bump verification (2026-09-14)

Scope: F02 freeze bump — RU-01 membership-only source identity + RU-05 versioned time config / weekSession course binding. Four diffs vs the d5a3407 freeze, each backed by an adopted ruling (not test-fitting):

| # | Bump | Ruling source |
|---|---|---|
| 1 | `sourceRecordSchema` drops `courseId` (was `uuid.nullable()`) | §0 Ruling + §2.1 (this doc) |
| 2 | `weekSessionSchema.courseId` nullable+optional; `courseName` stays display label | `interfaces.md` RU-05 line |
| 3 | `sourceCourseLinkInputSchema` / `Unlink` keep `clientKey` (min 8) | §0 Ruling (this doc) |
| 4 | `timeConfigSchema` gains `version` + `courseId`; new `timeConfigSaveInputSchema` (`expectedVersion` → 409) + `timeConfigSupportsAbsoluteScheduling` | `interfaces.md` RU-05 line |

Commands run on this machine (working tree, `feat/opening-release`):

```bash
npx vitest run packages/contracts/src/opening/contracts.test.ts
# → Test Files 1 passed (1), Tests 18 passed (18)

npx vitest run packages/database/src/repositories/opening-sources.test.ts \
  packages/database/src/repositories/course-membership.source.test.ts \
  apps/web/src/features/opening/sources/source-service.test.ts
# → Test Files 3 passed (3), Tests 10 passed (10)

npx tsc -p packages/contracts/tsconfig.json --noEmit
# → exit 0
```

Downstream impact check: no consumer outside contracts references `timeConfigSchema` / `weekSessionSchema`; `SourceRecord` consumers (`opening-sources` repo, `source-service`, course read projection) already aligned with membership-only identity (§8).
