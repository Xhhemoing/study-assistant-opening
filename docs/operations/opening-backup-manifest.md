# Opening backup / restore — scope + format contract (draft)

**Status:** draft for Q03 / PR-K. Not an executor implementation and not a verified restore drill.  
**Date:** 2026-10-12 (Asia/Shanghai)  
**Baseline assumptions:** code at the `fix/q03-restore-scope` worktree; schema from `packages/database/src/migrations/` (latest durable SQL id `0057_opening_help_exposure_kind.sql`).

This document unifies the **two existing backup paths** under one compatible story. It does **not** invent a third format.

| Path | Format id | Surface today | Honest scope |
|---|---|---|---|
| Legacy native content | `aistudy-native` (`NATIVE_BACKUP_FORMAT_VERSION = 1`) | `/opening/settings/export` + `/api/backups/*` (`BackupMenu`) | Library notes/revisions, courses/goals, explorations, cards/review state; embedded note file bytes only |
| Opening workspace | `opening-backup` (`version: 1`, archive magic `OPENING-BACKUP-V1`) | CLI / repositories (`exportOpeningBackup`, archive, cipher, apply) | Owner-scoped Opening durable tables + S3 source objects with digests; privacy journal |

Both paths share the same product meaning: **versioned, allowlisted, non-overwriting restore of durable learning assets**. Opening is the path that can claim workspace learning continuity; legacy native must never be labeled “完整恢复”.

---

## 1. Schema / migration version + hash protocol version

### 1.1 Schema binding

- Restore preflight MUST record `latestMigrationId` (filename of the last applied SQL migration on the **source**), matching how legacy native embeds `schemaManifest.latestMigrationId`.
- Opening archives SHOULD carry the same migration id in metadata (planned field; today the durable binding is the fixed table allowlist + FK order in `OPENING_RESTORE_APPLY_ORDER`).
- Applying into a target whose migration head is **behind** the archive is fail-closed. Applying into a **newer** head requires an explicit compatibility matrix (not claimed here).

### 1.2 Opening package + archive + cipher versions

| Layer | Identifier | Notes |
|---|---|---|
| Logical package | `format: "opening-backup"`, `version: 1` | Domain type `OpeningBackup` |
| Archive container | Magic `OPENING-BACKUP-V1` | `MAGIC \| u64 metadata length \| metadata JSON \| object bytes in declared order` |
| Object digest | SHA-256 hex (64 lowercase) | Source of truth is **streamed bytes**, not caller-supplied strings alone (`verifyOpeningBackupObjects` / archive write) |
| Object path | `objects/<sourceId>/v<version>.bin` (canonical: `objects/<uuid>/v<n>.bin`) | Matched to S3 `finalKey(sourceId, version)` on restore |
| Cipher envelope | Magic `OPENING-ENC-V1` | AES-256-GCM; scrypt key derivation; optional off-host encryption — secrets never inside DB restore |

### 1.3 Legacy native package version

| Layer | Identifier |
|---|---|
| Package | `format: "aistudy-native"`, `schemaManifest.formatVersion: 1` |
| Files | Embedded base64 optional; SHA-256 + byteLength required in file manifest |

---

## 2. DB record inventory (Opening path)

Opening export emits `tables: Record<tableName, row[]>` for the **allowlisted** durable set only (see §4 labels `原始`). Rows are owner/workspace scoped, privacy-filtered, and dependency-ordered on apply via `OPENING_RESTORE_APPLY_ORDER` (31 tables).

Inventory fields a complete export SHOULD publish in a future manifest sidecar (not all present as top-level fields today):

- `workspaceId`, `privacyEpoch`
- `deletionJournal[]` / `memoryDeletions`
- per-table `counts`
- `latestMigrationId`
- `recordDigests` (optional: ordered SHA-256 of canonical JSON lines) — **planned**

---

## 3. S3 objects + digests

For each exported source version:

| Field | Meaning |
|---|---|
| `sourceId` | UUID of `opening_sources` |
| `version` | Non-negative integer object version |
| `bytes` | Exact byte length |
| `sha256` | Hex digest of object bytes |
| `archivePath` | `objects/<sourceId>/v<version>.bin` |
| `actualSha256` | Digest measured from storage/archive (must equal `sha256`) |

Restore puts objects through `finalKey(sourceId, version)` and re-verifies digests before commit. Missing, truncated, or mismatched objects fail the whole apply (no partial success).

Chunks (`opening_source_chunks`) are DB text projections of parsed content; the **authoritative bytes** remain S3 objects. Rebuildable parse artifacts must not substitute for missing objects.

---

## 4. Persistent table classification (~73)

Labels:

- **原始 (raw)** — must be present in a complete Opening backup (or legacy native where noted) to preserve user meaning after restore.
- **可重建 (rebuildable)** — may be omitted if a documented rebuild job exists; including them is optional cache.
- **排除 (excluded)** — must not be restored from backup (secrets, ephemeral runtime, other-tenant, or wrong path).

Counts: migrations define **73** `CREATE TABLE` names (including `schema_migrations`). Classification below.

### 4.1 Identity / tenancy

| Table | Label | Reason |
|---|---|---|
| `users` | 排除 | Identity provider / bootstrap; not workspace portable content |
| `sessions` | 排除 | Auth sessions; Opening apply guarantees `sessionsRestored: false` |
| `workspaces` | 原始* | Target workspace must pre-exist / be provisioned; Opening apply assumes scoped empty namespace inside an existing workspace |
| `schema_migrations` | 排除 | Controlled by migrate tooling, not backup rows |

\*Workspace row identity is an apply **precondition**, not freely inserted from a foreign dump without operator policy.

### 4.2 Legacy native library (also in `aistudy-native`)

| Table | Label | Reason |
|---|---|---|
| `library_documents` | 原始 (legacy) | Native notes |
| `library_blocks` | 原始 (legacy) | Note body |
| `library_revisions` | 原始 (legacy) | Revision history |
| `library_relations` | 原始 (legacy) | Relations |
| `library_properties` | 原始 (legacy) | Properties |
| `courses` | 原始 (both) | Course shell; Opening allowlist includes learning flags |
| `course_asset_memberships` | 原始 (both) | Opening exports **source** memberships only |
| `course_goals` | 原始 (legacy) | Goals |
| `goal_time_windows` | 原始 (legacy) | Goal windows |
| `explorations` | 原始 (legacy) | Old explorations |
| `exploration_branches` | 原始 (legacy) | |
| `exploration_blocks` | 原始 (legacy) | |
| `promotion_records` | 原始 (legacy) | |
| `promotion_targets` | 原始 (legacy) | |
| `cards` | 原始 (legacy) | |
| `card_review_states` | 原始 (legacy) | |
| `learning_events` | 原始 (legacy) | Legacy review events |
| `workspace_preferences` | 原始 (Opening) | AI/planning/intervention prefs; Opening allowlist |
| `revision_proposals` | 排除 / 待决 | Not on Opening allowlist; treat as non-portable until scoped |

### 4.3 Opening sources + learning continuum (Opening allowlist)

| Table | Label | Reason |
|---|---|---|
| `opening_sources` | 原始 | Source metadata |
| `opening_source_versions` | 原始 | Bytes/sha256/availability |
| `opening_source_chunks` | 原始 | Locator text; pairs with S3 objects |
| `opening_conversations` | 原始 | Tutor threads |
| `opening_turns` | 原始 | Includes `client_key` idempotency |
| `opening_teaching_activities` | 原始 | Includes `client_key` |
| `opening_teaching_units` | 原始 | Teaching content |
| `opening_teaching_activity_specs` | 原始 | Specs |
| `opening_learning_sessions` | 原始 | |
| `opening_problem_refs` | 原始 | |
| `opening_learning_history_revisions` | 原始 | Counters |
| `opening_learning_activity_history_revisions` | 原始 | Counters |
| `opening_workspace_history_revisions` | 原始 | Counters |
| `opening_learning_item_versions` | 原始 | |
| `opening_learning_attempts` | 原始 | Includes `client_key` |
| `opening_assistant_candidates` | 原始 | Includes `task_accept_client_key` (retest/task accept) |
| `opening_help_exposures` | 原始 | |
| `opening_learning_observations` | 原始 | Includes `client_key` |
| `opening_skill_evidence` | 原始 | |
| `opening_memories` | 原始 | Includes `last_decision_client_key` |
| `opening_privacy_exclusions` | 原始 | Deletion journal facts |
| `opening_tasks` | 原始 | **Must include `client_key`** (quick-add idempotency) |
| `opening_retest_activities` | 原始 | Retest lifecycle |
| `opening_timetable_sessions` | 原始 | |
| `opening_hard_blocks` | 原始 | |
| `opening_plan_state` | 原始 | |
| `opening_plan_drafts` | 原始 | Includes `propose_client_key` |
| `opening_plan_acceptances` | 原始 | PK includes `client_key` |

### 4.4 Opening adjacent / rebuildable / excluded

| Table | Label | Reason |
|---|---|---|
| `opening_learning_eligibility` | **待决** → default 可重建 | Derived from observations + policy; see §5 |
| `opening_model_providers` | **待决** | Settings UI; no secrets in row, but restore policy open — see §5 |
| `opening_model_provider_models` | **待决** | Companion to providers — see §5 |
| `opening_model_provider_credentials` | 排除 | AES-GCM API key envelopes; Opening guarantees `apiKeysRestored: false` / `secretsRestored: false` |
| `opening_connection_credentials` | 排除 | Connection secrets |
| `opening_connection_credential_requests` | 排除 | Secret request flow |
| `opening_connections` | 排除* | Non-secret connection config could become 原始 later; today not on allowlist |
| `opening_import_receipts` | 原始† | Mail/import audit; not yet on apply allowlist — gap |
| `opening_import_cursors` | 排除 / 可重建 | Sync cursors; unsafe to replay blindly |
| `opening_jobs` | 排除 | Runtime jobs; restore cancels pending paid work |
| `opening_outbox` | 排除 | Delivery outbox |
| `opening_tutor_jobs` | 排除 | Runtime |
| `opening_budget_reservations` | 排除 | Spend ledger; do not replay |
| `opening_action_digest_decisions` | 原始† | Idempotent decisions with `client_key`; not yet on allowlist — gap |
| `opening_course_knowledge` | 原始† | Course knowledge graph; not yet on allowlist — gap |
| `opening_ephemeral_provenance` | 排除 | Ephemeral |
| `opening_note_provenance` | 原始† | Note↔source provenance; not yet on allowlist — gap |
| `content_packages` | 排除 | Global practice catalog, not workspace backup |
| `syllabus_nodes` | 排除 | Catalog |
| `practice_items` | 排除 | Catalog |
| `practice_item_versions` | 排除 | Catalog |
| `practice_sessions` | 排除 / 待决 | Legacy practice runtime; not Opening allowlist |

† Marked 原始† = durable user meaning, but **not** in current `OPENING_RESTORE_APPLY_ORDER` — tracked as packaging gaps, not silently claimed restored.

---

## 5. Explicit 待决 items

### 5.1 `opening_learning_eligibility`

- **Nature:** rebuildable derived eligibility (`0038_opening_learning_eligibility.sql` comment: immutable learning facts remain authoritative).
- **Draft decision:** omit from backup by default; rebuild after restore from observations + policy version.
- **Open:** whether a cache snapshot is allowed for offline forensics (would be 可重建, never sole source of truth).

### 5.2 `opening_model_providers` / `opening_model_provider_models`

- **Nature:** workspace BYOK provider catalog (labels, base URL, model pricing metadata).
- **Credentials** stay in `opening_model_provider_credentials` → always **排除**.
- **Open:** export non-secret provider/model rows so UI routing survives migration, vs require re-entry (settings copy already warns native backup omits model routing). Until decided: **待决**, do not claim restored.

---

## 6. Idempotent keys — restore invariants (MUST)

After a successful Opening restore into an empty owner namespace, **replaying the same client key MUST return the existing entity** (same semantics as pre-backup online handlers). Backup/restore is not allowed to drop these columns or unique indexes.

### 6.1 `opening_tasks.client_key`

- **Online:** quick-add (`candidateId === null`) stores `client_key` on `opening_tasks`; unique index `opening_tasks_workspace_owner_client_key_uidx` (nullable key ignored).
- **Invariant:** restore MUST export and re-insert `client_key` so a post-restore quick-add with the same key returns the existing task (or CONFLICT on payload mismatch), never a second row.
- **Code (PR-K):** export SQL and `OPENING_RESTORE_ROW_COLUMNS.opening_tasks` previously omitted `client_key` — **fixed** in this branch (allowlist + `opening-backup-record-table-queries`).

### 6.2 Retest / task accept keys

| Key | Storage | Invariant |
|---|---|---|
| Retest accept | `opening_jobs.payload.acceptClientKey` (kind `retest`) + task row | Replay with same key returns existing task; Opening jobs themselves are **排除** / cancelled — accept receipt must be reconstructed from durable task + candidate fields, not by replaying paid jobs |
| Assistant task accept | `opening_assistant_candidates.task_accept_client_key` (+ intent/result ref) | Restored with candidates; replay must hit existing acceptance |
| Plan propose / accept | `opening_plan_drafts.propose_client_key`, `opening_plan_acceptances.client_key` | Already on allowlist |
| Learning observation / attempt / turn / teaching activity | respective `client_key` columns | Already on allowlist |
| Memory decisions | `opening_memories.last_decision_client_key` | Already on allowlist |

**Gap note:** retest accept receipts primarily live on **excluded** `opening_jobs`. Durable fallback today is `opening_tasks` + `opening_retest_activities` + `opening_assistant_candidates.task_accept_*`. Post-restore retest accept replay MUST remain satisfied via those durable rows; if a receipt exists only on a cancelled job payload, treat as a known packaging gap (document, do not invent a third backup format).

---

## 7. Unifying the two paths (no third format)

1. **Product copy:** settings export UI describes legacy native as **library-scoped**, never “完整恢复”. Opening CLI/ops docs describe the `opening-backup` package as the workspace learning path.
2. **Compatibility:** Opening restore may sit beside restored native library rows in one workspace; it must not redefine `aistudy-native` JSON.
3. **Future single operator story:** one confirm-gated ops flow that (a) restores Opening package + objects, (b) optionally restores native package for library tables, (c) never merges them into a new incompatible envelope.
4. **Out of scope this pass:** Docker packaging, full live DB+S3 export executor, live restore drills.

---

## 8. References (code)

- Domain allowlist / validate: `packages/domain/src/opening/backup-policy.ts`, `backup-apply-plan.ts`
- Export queries: `packages/database/src/repositories/opening-backup-record-table-queries.ts`
- Apply columns: `packages/database/src/repositories/opening-backup-apply.ts` (`OPENING_RESTORE_ROW_COLUMNS`)
- Archive / cipher: `opening-backup-archive.ts`, `opening-backup-cipher.ts`
- Object verify: `opening-backup-manifest.ts`
- Restore CLI env (explicit DB only): `opening-restore-cli-env.ts`
- Legacy native: `packages/contracts/src/backup.ts`, `apps/web/.../backup-menu-model.ts`
