import { randomUUID } from "node:crypto";
import { issueOpeningReservedQuestion, type OpeningReservedPorts } from "./opening-course-reserved-selection";
import { assertReferenceTextRevision } from "./opening-teaching-reference-revision";

type ReferenceRevisionInput = { expectedContentVersion: number; expectedRevisionNumber: number; revisionNumber: number };
import { assertOpeningCourseRouteCurrent } from "./opening-course-route-origin";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
import { teachingSourceRefSchema } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import type {
  ActivitySpec,
  ActivitySpecClientInit,
  ActivitySpecPublishInput,
  Scope,
  TeachingAnswerKey,
  TeachingBlockRef,
  TeachingDraftAnchor,
  TeachingDraftAnchorsSaveInput,
  TeachingDraftAnchorsSaveResult,
  TeachingCheckpointSaveInput,
  TeachingCheckpointSaveResult,
  TeachingGenerationConfig,
  TeachingGoal,
  TeachingSourceRef,
  TeachingUnit,
  TeachingUnitCreateInput,
  TeachingVerificationStatus,
} from "@aistudy/contracts";
import { mergeCheckpointResumePatch } from "@aistudy/domain";
import { repairDecodedLatexInJson } from "@aistudy/ai";
import { readOpeningTeachingAnswerKey } from "./opening-teaching-hints";
import { mapLearningAttempt } from "./opening-learning-attempts";
import { qualifyObservationRevision } from "./opening-observation-revision-history";
import {
  assertOwnedActivity,
} from "./opening-teaching-activities";
import {
  learningError,
  learningIso,
  admitLearningSources,
  lockLearningOwner,
} from "./opening-learning-facts";
import {
  createLibraryRepository,
  type RevisionRecord,
} from "./library";

function asGoals(value: unknown): TeachingGoal[] {
  return Array.isArray(value) ? (value as TeachingGoal[]) : [];
}

function asBlockOrder(value: unknown): TeachingBlockRef[] {
  return Array.isArray(value) ? (value as TeachingBlockRef[]) : [];
}

function asSourceRefs(value: unknown): TeachingSourceRef[] {
  return Array.isArray(value) ? (value as TeachingSourceRef[]) : [];
}

function asGenerationConfig(value: unknown): TeachingGenerationConfig {
  return (value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {}) as TeachingGenerationConfig;
}

function mapUnit(row: Record<string, unknown>): TeachingUnit {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ownerUserId: String(row.owner_user_id),
    title: String(row.title),
    documentId: String(row.document_id),
    currentRevisionNumber: Number(row.current_revision_number),
    goals: asGoals(row.goals_json),
    verificationStatus: row.verification_status as TeachingVerificationStatus,
    generationConfig: asGenerationConfig(row.generation_config),
    version: Number(row.version),
    createdAt: learningIso(row.created_at)!,
    updatedAt: learningIso(row.updated_at)!,
  };
}

function mapSpec(row: Record<string, unknown>): ActivitySpec {
  return {
    id: String(row.id),
    activityId: String(row.activity_id),
    teachingUnitId: String(row.teaching_unit_id),
    documentId: String(row.document_id),
    revisionNumber: Number(row.revision_number),
    blockOrder: asBlockOrder(row.block_order),
    sourceRefs: asSourceRefs(row.source_refs),
    goals: asGoals(row.goals_json),
    verificationStatus: row.verification_status as TeachingVerificationStatus,
    generationConfig: asGenerationConfig(row.generation_config),
    version: Number(row.version),
    createdAt: learningIso(row.created_at)!,
    updatedAt: learningIso(row.updated_at)!,
  };
}

/** Soft-idempotent graph equality set (PM freeze / knowledge pattern). */
export function sameActivitySpecGraph(
  left: {
    teachingUnitId: string;
    documentId: string;
    revisionNumber: number;
    blockOrder: TeachingBlockRef[];
    sourceRefs: TeachingSourceRef[];
    goals: TeachingGoal[];
    verificationStatus: TeachingVerificationStatus;
    generationConfig: TeachingGenerationConfig;
  },
  right: {
    teachingUnitId: string;
    documentId: string;
    revisionNumber: number;
    blockOrder: TeachingBlockRef[];
    sourceRefs: TeachingSourceRef[];
    goals: TeachingGoal[];
    verificationStatus: TeachingVerificationStatus;
    generationConfig: TeachingGenerationConfig;
  },
): boolean {
  return isDeepStrictEqual(
    {
      teachingUnitId: left.teachingUnitId,
      documentId: left.documentId,
      revisionNumber: left.revisionNumber,
      blockOrder: left.blockOrder,
      sourceRefs: left.sourceRefs,
      goals: left.goals,
      verificationStatus: left.verificationStatus,
      generationConfig: left.generationConfig,
    },
    {
      teachingUnitId: right.teachingUnitId,
      documentId: right.documentId,
      revisionNumber: right.revisionNumber,
      blockOrder: right.blockOrder,
      sourceRefs: right.sourceRefs,
      goals: right.goals,
      verificationStatus: right.verificationStatus,
      generationConfig: right.generationConfig,
    },
  );
}

function isAnswerKeyBlock(blockType: string, role: string): boolean {
  return role === "answer_key" || blockType === "answer_key" || blockType === "solution";
}

/**
 * Project library revision blocks into client-safe init blocks.
 * Answer-key plaintext is replaced with opaque answerRef { revealState: "hidden" }.
 */
export function redactBlocksForClientInit(
  blockOrder: TeachingBlockRef[],
  revisionBlocks: Array<{ id: string; type: string; position: number; content: Record<string, unknown> }>,
): ActivitySpecClientInit["blocks"] {
  const byId = new Map(revisionBlocks.map((b) => [b.id, b]));
  return blockOrder.map((ref) => {
    const body = byId.get(ref.blockId);
    const blockType = ref.blockType || body?.type || "text";
    const role = ref.role;
    if (isAnswerKeyBlock(blockType, role)) {
      return {
        blockId: ref.blockId,
        position: ref.position,
        blockType,
        role: "answer_key" as const,
        content: null,
        answerRef: { refId: ref.blockId, revealState: "hidden" as const },
      };
    }
    return {
      blockId: ref.blockId,
      position: ref.position,
      blockType,
      role,
      // Revisions are append-only; LaTeX decoded by the pre-parseModelJson compiler
      // (TAB+"imes" for \times ...) is repaired on the way out instead of in place.
      content: body?.content ? repairDecodedLatexInJson(body.content).value : null,
    };
  });
}

/**
 * Snapshot helper for restore / checkpoint dumps: never places unrevealed
 * answer-key plaintext into checkpoint_json.
 */
export function sanitizeCheckpointForRestore(
  checkpoint: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!checkpoint || typeof checkpoint !== "object") return {};
  const clone = structuredClone(checkpoint) as Record<string, unknown>;
  delete clone.answerKeys;
  delete clone.solutions;
  delete clone.unrevealedAnswers;
  if (Array.isArray(clone.blocks)) {
    clone.blocks = (clone.blocks as unknown[]).map((raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const block = { ...(raw as Record<string, unknown>) };
      const role = String(block.role ?? "");
      const blockType = String(block.blockType ?? block.type ?? "");
      if (isAnswerKeyBlock(blockType, role)) {
        block.content = null;
        block.answerRef = {
          refId: String(block.blockId ?? block.id ?? randomUUID()),
          revealState: "hidden",
        };
      }
      return block;
    });
  }
  return clone;
}

/** Publication owns source identity; callers must keep these locks through the write. */
async function assertPublishSourceRefs(
  tx: TransactionSql,
  scope: Scope,
  refs: TeachingSourceRef[],
): Promise<void> {
  if (!refs.length) return;
  for (const ref of refs) {
    if (!teachingSourceRefSchema.safeParse(ref).success || (ref.page != null && ref.page > 2147483647)
      || (ref.version != null && (!/^(0|[1-9]\d*)$/.test(String(ref.version))
        || !Number.isSafeInteger(Number(ref.version)) || Number(ref.version) > 2147483647))) {
      throw learningError("VALIDATION", "source ref requires a valid version and location");
    }
  }
  const sourceIds = [...new Set(refs.map(ref => ref.sourceId))].sort();
  // FOR SHARE blocks source replacement/deletion until the spec transaction commits.
  const sources = await tx`SELECT s.id,s.version FROM opening_sources s
    WHERE s.workspace_id=${scope.workspaceId} AND s.id IN ${tx(sourceIds)}
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
    ORDER BY s.id FOR SHARE OF s`;
  if (sources.length !== sourceIds.length) throw learningError("VALIDATION", "source ref is unavailable in this workspace");
  const currentVersions = new Map(sources.map(row => [String(row.id), Number(row.version)]));
  for (const ref of refs) {
    // Historical lineage is valid. Older imports may have chunks but no version journal.
    const versions = await tx`SELECT version,availability FROM opening_source_versions
      WHERE workspace_id=${scope.workspaceId} AND source_id=${ref.sourceId} ORDER BY version FOR SHARE`;
    const version = ref.version == null ? null : Number(ref.version);
    const located = ref.chunkId != null || ref.page != null;
    const unavailable = new Set(versions.filter(row => row.availability === "unavailable").map(row => Number(row.version)));
    if ((version != null || !located) && unavailable.has(version ?? currentVersions.get(ref.sourceId)!)) {
      throw learningError("VALIDATION", "source ref version is unavailable");
    }
    const knownVersion = version == null || version === currentVersions.get(ref.sourceId)
      || versions.some(row => Number(row.version) === version);
    // Whole-source fallback refs need neither a pinned version nor parsed chunks.
    if (!located && knownVersion) continue;
    // Pages have no separate catalog: parsed chunks are the authoritative page set.
    // Compare ids as text so malformed external chunk ids are VALIDATION, not PG casts.
    const chunks = await tx`SELECT id,source_version FROM opening_source_chunks
      WHERE source_id=${ref.sourceId} AND (${version}::integer IS NULL OR source_version=${version})
        AND (${ref.chunkId ?? null}::text IS NULL OR id::text=${ref.chunkId ?? null})
        AND (${ref.page ?? null}::integer IS NULL OR page=${ref.page ?? null})
      ORDER BY id FOR SHARE`;
    if (!chunks.some(row => !unavailable.has(Number(row.source_version)))) {
      throw learningError(knownVersion ? "VALIDATION" : "CONFLICT", "source ref version, chunk or page does not exist or is unavailable");
    }
  }
}

export function createOpeningTeachingContentRepository(sql: Sql, reservedPorts?: OpeningReservedPorts) {
  const library = createLibraryRepository(sql);

  return {
    /** Restore a precise question, including its current revision, without replaying writes. */
    async getSubmittedAttempt(scope: Scope, activityId: string, blockId: string, contentVersion: number) {
      return sql.begin(async tx => {
        await lockLearningOwner(tx, scope);
        const activities = await tx`SELECT a.content_version FROM opening_teaching_activities a
          JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=${scope.ownerUserId}
          WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} FOR SHARE OF a`;
        if (!activities[0]) throw learningError("NOT_FOUND", "teaching activity not found");
        if (Number(activities[0].content_version) !== contentVersion) throw learningError("CONFLICT", "teaching content changed; reread the activity");
        const rows = await tx`SELECT a.* FROM opening_learning_attempts a
          WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
            AND a.activity_id=${activityId} AND a.submitted_at IS NOT NULL
            AND a.create_intent->'teachingBlock'->>'blockId'=${blockId}
            AND a.create_intent->'teachingBlock'->>'contentVersion'=${String(contentVersion)}
          ORDER BY a.submitted_at DESC, a.id DESC LIMIT 1`;
        if (!rows[0]) return null;
        const attempt = mapLearningAttempt(rows[0]);
        const heads = await tx`SELECT head.* FROM opening_learning_observations root
          JOIN opening_learning_observations head ON head.id=COALESCE(root.effective_head_id,root.id)
            AND head.workspace_id=root.workspace_id AND head.owner_user_id=root.owner_user_id
          WHERE root.id=${attempt.observationId} AND root.workspace_id=${scope.workspaceId}
            AND root.owner_user_id=${scope.ownerUserId} AND root.activity_id=${activityId}
            AND root.attempt_id=${attempt.id}`;
        const head = heads[0];
        const observation = head && head.revision_kind !== "retract" ? await qualifyObservationRevision(tx, scope, head) : null;
        await admitLearningSources(tx, scope, attempt.sourceIds);
        return { attempt, observation };
      });
    },
    /** Never unlock a different prompt or a changed revision using an old answer. */
    async getSubmittedAnswerKey(scope: Scope, activityId: string, blockId: string, attemptId: string): Promise<TeachingAnswerKey> {
      return sql.begin(tx => readOpeningTeachingAnswerKey(tx, scope, activityId, blockId, attemptId));
    },
    async createUnit(scope: Scope, input: TeachingUnitCreateInput): Promise<TeachingUnit> {
      const lifecycle = input.lifecycle ?? "candidate";
      const goals = input.goals ?? [];
      const generationConfig = input.generationConfig ?? {};
      const verificationStatus = input.verificationStatus ?? "unchecked";
      const blocks = (input.blocks ?? []).map((b) => ({
        id: b.id,
        type: b.type,
        content: b.content,
      }));

      const document = await library.createDocument({
        workspaceId: scope.workspaceId,
        jobScope: scope,
        title: input.title,
        lifecycle,
        blocks,
      });

      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const id = randomUUID();
        const rows = await tx`
          INSERT INTO opening_teaching_units (
            id, workspace_id, owner_user_id, title, document_id,
            current_revision_number, goals_json, verification_status,
            generation_config, version
          ) VALUES (
            ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.title},
            ${document.id}, ${document.currentRevisionNumber},
            ${tx.json(goals as never)}, ${verificationStatus},
            ${tx.json(generationConfig as never)}, 0
          )
          RETURNING *`;
        return mapUnit(rows[0] as Record<string, unknown>);
      });
    },

    async getUnit(scope: Scope, unitId: string): Promise<TeachingUnit | null> {
      const rows = await sql`
        SELECT u.* FROM opening_teaching_units u
        JOIN workspaces w ON w.id = u.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
        WHERE u.id = ${unitId}
          AND u.workspace_id = ${scope.workspaceId}
          AND u.owner_user_id = ${scope.ownerUserId}`;
      if (!rows.length) return null;
      return mapUnit(rows[0] as Record<string, unknown>);
    },

    /**
     * Write compiled blocks as the next revision of the unit's body document.
     * Publish then pins the returned revision so client-init reads these bodies.
     */
    async writeUnitBlocks(
      scope: Scope,
      unitId: string,
      blocks: Array<{ id: string; type: string; content: Record<string, unknown> }>,
    ): Promise<{ documentId: string; revisionNumber: number }> {
      const unit = await this.getUnit(scope, unitId);
      if (!unit) throw learningError("NOT_FOUND", "teaching unit not found");
      const current = await library.getDocument({
        workspaceId: scope.workspaceId,
        documentId: unit.documentId,
      });
      const updated = await library.updateDocument({
        workspaceId: scope.workspaceId,
        jobScope: scope,
        documentId: unit.documentId,
        expectedRevisionNumber: current.currentRevisionNumber,
        blocks: blocks.map((b) => ({ id: b.id, type: b.type, content: b.content })),
        reason: "teaching-compile",
      });
      return { documentId: unit.documentId, revisionNumber: updated.currentRevisionNumber };
    },

    async listUnits(scope: Scope): Promise<TeachingUnit[]> {
      const rows = await sql`
        SELECT u.* FROM opening_teaching_units u
        JOIN workspaces w ON w.id = u.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
        WHERE u.workspace_id = ${scope.workspaceId}
          AND u.owner_user_id = ${scope.ownerUserId}
        ORDER BY u.updated_at DESC, u.id`;
      return rows.map((row) => mapUnit(row as Record<string, unknown>));
    },

    /** Preflight only; publication repeats the check under its own write transaction. */
    async validateActivitySourceRefs(scope: Scope, input: Pick<ActivitySpecPublishInput, "activityId" | "sourceRefs">): Promise<void> {
      await sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await lockLearningOwner(tx, scope);
        await assertOwnedActivity(tx as unknown as Sql, scope, input.activityId);
        await assertOpeningCourseRouteCurrent(tx, scope, input.activityId);
        await assertPublishSourceRefs(tx, scope, input.sourceRefs ?? []);
      });
    },

    /**
     * Publish / upsert current ActivitySpec and bump activity.content_version with CAS.
     * Soft-idempotent: if already at expectedVersion+1 AND sameSpecGraph → success.
     */
    async publishActivitySpec(
      scope: Scope,
      input: ActivitySpecPublishInput,
      referenceRevision?: ReferenceRevisionInput,
    ): Promise<ActivitySpec> {
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
        throw learningError("VALIDATION", "expectedVersion must be a non-negative integer");
      }
      const newVersion = input.expectedVersion + 1;
      const sourceRefs = input.sourceRefs ?? [];
      const goals = input.goals ?? [];
      const verificationStatus = input.verificationStatus ?? "unchecked";
      const generationConfig = input.generationConfig ?? {};
      const desiredGraph = {
        teachingUnitId: input.teachingUnitId,
        documentId: "", // filled after unit load
        revisionNumber: input.revisionNumber,
        blockOrder: input.blockOrder,
        sourceRefs,
        goals,
        verificationStatus,
        generationConfig,
      };

      return sql.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        await lockLearningOwner(tx, scope);
        await assertOwnedActivity(tx as unknown as Sql, scope, input.activityId);

        const unitRows = await tx`
          SELECT * FROM opening_teaching_units
          WHERE id = ${input.teachingUnitId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!unitRows.length) throw learningError("NOT_FOUND", "teaching unit not found");
        const unit = unitRows[0] as Record<string, unknown>;
        desiredGraph.documentId = String(unit.document_id);

        if (input.expectedRevisionNumber != null) {
          const rev = Number(unit.current_revision_number);
          if (input.expectedRevisionNumber !== rev) {
            throw learningError(
              "CONFLICT",
              `teaching unit document is at revision ${rev}; expected ${input.expectedRevisionNumber}`,
            );
          }
        }

        const activityRows = await tx`
          SELECT * FROM opening_teaching_activities
          WHERE id = ${input.activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!activityRows.length) throw learningError("NOT_FOUND", "teaching activity not found");
        const activity = activityRows[0] as Record<string, unknown>;
        const currentContentVersion = Number(activity.content_version);

        const existingSpecRows = await tx`
          SELECT * FROM opening_teaching_activity_specs
          WHERE workspace_id = ${scope.workspaceId}
            AND activity_id = ${input.activityId}
          FOR UPDATE`;
        const existingSpec = existingSpecRows[0]
          ? mapSpec(existingSpecRows[0] as Record<string, unknown>)
          : null;

        if (referenceRevision) {
          if (!existingSpec || !sameActivitySpecGraph(existingSpec, {
            ...desiredGraph, revisionNumber: existingSpec.revisionNumber,
            verificationStatus: existingSpec.verificationStatus,
          })) throw learningError("CONFLICT", "teaching spec changed; reread before adopting");
          if (activity.status === "completed" || ["queued", "generating"].includes(String(activity.generate_status))) {
            throw learningError("CONFLICT", "teaching activity cannot adopt a reference revision now");
          }
          const replay = currentContentVersion === newVersion && existingSpec.revisionNumber === input.revisionNumber;
          const receipt = (activity.checkpoint_json as Record<string, unknown> | null)?.referenceRevisionAdoption;
          if (replay ? !isDeepStrictEqual(receipt, referenceRevision)
            : existingSpec.revisionNumber !== referenceRevision.expectedRevisionNumber) {
            throw learningError("CONFLICT", "stale pinned reference revision");
          }
          const [document] = await tx`SELECT current_revision_number FROM library_documents
            WHERE id=${existingSpec.documentId} AND workspace_id=${scope.workspaceId} AND deleted_at IS NULL FOR UPDATE`;
          if (!document || Number(document.current_revision_number) !== input.revisionNumber
            || input.revisionNumber <= referenceRevision.expectedRevisionNumber) throw learningError("CONFLICT", "saved document revision changed; save and reread before adopting");
          const revisions = await tx`SELECT revision_number,blocks FROM library_revisions
            WHERE workspace_id=${scope.workspaceId} AND document_id=${existingSpec.documentId}
              AND revision_number IN (${referenceRevision.expectedRevisionNumber},${input.revisionNumber})`;
          const before = revisions.find(row => Number(row.revision_number) === referenceRevision.expectedRevisionNumber);
          const after = revisions.find(row => Number(row.revision_number) === input.revisionNumber);
          if (!before || !after) throw learningError("CONFLICT", "saved reference revision not found");
          assertReferenceTextRevision(existingSpec.blockOrder, before.blocks as RevisionRecord["blocks"], after.blocks as RevisionRecord["blocks"]);
          await assertOpeningCourseRouteCurrent(tx, scope, input.activityId);
        }

        if (currentContentVersion === newVersion && existingSpec) {
          if (
            sameActivitySpecGraph(existingSpec, {
              ...desiredGraph,
              documentId: desiredGraph.documentId,
            })
          ) {
            return existingSpec;
          }
          throw learningError("CONFLICT", "stale activity content version with different spec graph");
        }
        await assertOpeningCourseRouteCurrent(tx, scope, input.activityId);
        if (currentContentVersion !== input.expectedVersion) {
          throw learningError("CONFLICT", "stale activity content version");
        }
        if (activity.status === "completed") throw learningError("CONFLICT", "completed teaching activity cannot publish new content");
        await assertPublishSourceRefs(tx, scope, sourceRefs);

        const specId = existingSpec?.id ?? randomUUID();
        const upserted = await tx`
          INSERT INTO opening_teaching_activity_specs (
            id, workspace_id, owner_user_id, activity_id, teaching_unit_id,
            document_id, revision_number, block_order, source_refs, goals_json,
            verification_status, generation_config, version
          ) VALUES (
            ${specId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.activityId},
            ${input.teachingUnitId}, ${desiredGraph.documentId}, ${input.revisionNumber},
            ${tx.json(input.blockOrder as never)}, ${tx.json(sourceRefs as never)},
            ${tx.json(goals as never)}, ${verificationStatus},
            ${tx.json(generationConfig as never)}, ${newVersion}
          )
          ON CONFLICT (workspace_id, activity_id) DO UPDATE SET
            teaching_unit_id = EXCLUDED.teaching_unit_id,
            document_id = EXCLUDED.document_id,
            revision_number = EXCLUDED.revision_number,
            block_order = EXCLUDED.block_order,
            source_refs = EXCLUDED.source_refs,
            goals_json = EXCLUDED.goals_json,
            verification_status = EXCLUDED.verification_status,
            generation_config = EXCLUDED.generation_config,
            version = EXCLUDED.version,
            updated_at = now()
          RETURNING *`;

        const bumped = await tx`
          UPDATE opening_teaching_activities
          SET content_version = ${newVersion}, updated_at = now(),
              checkpoint_json = CASE WHEN ${Boolean(referenceRevision)} THEN
                COALESCE(checkpoint_json, '{}'::jsonb) || ${tx.json({ referenceRevisionAdoption: referenceRevision ?? null } as never)}
                ELSE checkpoint_json END
          WHERE id = ${input.activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND content_version = ${input.expectedVersion}
          RETURNING id`;
        if (!bumped.length) throw learningError("CONFLICT", "activity content version raced");

        await tx`
          UPDATE opening_teaching_units
          SET current_revision_number = GREATEST(current_revision_number, ${input.revisionNumber}),
              updated_at = now()
          WHERE id = ${input.teachingUnitId}
            AND workspace_id = ${scope.workspaceId}`;

        return mapSpec(upserted[0] as Record<string, unknown>);
      });
    },

    async adoptReferenceRevision(scope: Scope, activityId: string, input: ReferenceRevisionInput): Promise<ActivitySpec> {
      const spec = await this.getActivitySpec(scope, activityId);
      if (!spec) throw learningError("NOT_FOUND", "activity spec not found");
      return this.publishActivitySpec(scope, {
        activityId, teachingUnitId: spec.teachingUnitId, expectedVersion: input.expectedContentVersion,
        revisionNumber: input.revisionNumber, blockOrder: spec.blockOrder, sourceRefs: spec.sourceRefs,
        goals: spec.goals, generationConfig: spec.generationConfig, verificationStatus: "needs_check",
      }, input);
    },

    async getActivitySpec(scope: Scope, activityId: string): Promise<ActivitySpec | null> {
      await assertOwnedActivity(sql, scope, activityId);
      const rows = await sql`
        SELECT s.* FROM opening_teaching_activity_specs s
        WHERE s.workspace_id = ${scope.workspaceId}
          AND s.owner_user_id = ${scope.ownerUserId}
          AND s.activity_id = ${activityId}`;
      if (!rows.length) return null;
      return mapSpec(rows[0] as Record<string, unknown>);
    },

    /**
     * M1: only the current ActivitySpec row is retained (no history table).
     * Returns the current row when `version` matches; otherwise null.
     * Past body: use readRevision(documentId, revisionNumber).
     */
    async getActivitySpecAtVersion(
      scope: Scope,
      activityId: string,
      version: number,
    ): Promise<ActivitySpec | null> {
      const current = await this.getActivitySpec(scope, activityId);
      if (!current) return null;
      if (current.version !== version) return null;
      return current;
    },

    async getClientInit(scope: Scope, activityId: string): Promise<ActivitySpecClientInit | null> {
      await sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await issueOpeningReservedQuestion(tx, scope, activityId, reservedPorts);
      });
      const activity = await assertOwnedActivity(sql, scope, activityId);
      const spec = await this.getActivitySpec(scope, activityId);
      if (!spec) return null;

      const revision = await library.getRevision({
        workspaceId: scope.workspaceId,
        documentId: spec.documentId,
        revisionNumber: spec.revisionNumber,
      });

      const blocks = redactBlocksForClientInit(spec.blockOrder, revision.blocks);
      const checkpointJson = sanitizeCheckpointForRestore(
        activity.checkpointJson as Record<string, unknown> | undefined,
      );

      return {
        ...spec,
        blocks,
        contentVersion: activity.contentVersion,
        checkpointJson,
      };
    },

    async saveDraftAnchors(
      scope: Scope,
      activityId: string,
      input: TeachingDraftAnchorsSaveInput,
    ): Promise<TeachingDraftAnchorsSaveResult> {
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const activityRows = await tx`
          SELECT * FROM opening_teaching_activities
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!activityRows.length) throw learningError("NOT_FOUND", "teaching activity not found");
        const activity = activityRows[0] as Record<string, unknown>;
        const contentVersion = Number(activity.content_version);
        if (contentVersion !== input.expectedVersion) {
          throw learningError("CONFLICT", "stale activity content version for draft save");
        }
        if (activity.status === "completed") throw learningError("CONFLICT", "completed teaching activity cannot save new drafts");

        const specRows = await tx`
          SELECT block_order FROM opening_teaching_activity_specs
          WHERE workspace_id = ${scope.workspaceId}
            AND activity_id = ${activityId}
          FOR SHARE`;
        const blockOrder = specRows[0]
          ? asBlockOrder((specRows[0] as Record<string, unknown>).block_order)
          : [];
        const present = new Set(blockOrder.map((b) => b.blockId));
        const lostBlockIds = input.drafts
          .map((d) => d.blockId)
          .filter((id) => !present.has(id));
        if (lostBlockIds.length) {
          return {
            ok: false as const,
            mismatch: "draft_anchor_lost" as const,
            lostBlockIds: [...new Set(lostBlockIds)],
          };
        }

        const prev = (activity.checkpoint_json ?? {}) as Record<string, unknown>;
        const nextCheckpoint = {
          ...prev,
          drafts: input.drafts as TeachingDraftAnchor[],
        };
        const updated = await tx`
          UPDATE opening_teaching_activities
          SET checkpoint_json = ${tx.json(nextCheckpoint as never)}, updated_at = now()
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND content_version = ${input.expectedVersion}
          RETURNING content_version, checkpoint_json`;
        if (!updated.length) throw learningError("CONFLICT", "draft save raced");
        return {
          ok: true as const,
          contentVersion: Number((updated[0] as Record<string, unknown>).content_version),
          checkpointJson: (updated[0] as Record<string, unknown>).checkpoint_json as Record<
            string,
            unknown
          >,
        };
      });
    },


    /**
     * V2-14 checkpoint CAS write. Merges via mergeCheckpointResumePatch so
     * interventionPrefs/Decisions and V2-12 command keys are preserved.
     * Does not bump content_version (same as saveDraftAnchors).
     */
    async saveCheckpoint(
      scope: Scope,
      activityId: string,
      input: TeachingCheckpointSaveInput,
    ): Promise<TeachingCheckpointSaveResult> {
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const activityRows = await tx`
          SELECT * FROM opening_teaching_activities
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!activityRows.length) throw learningError("NOT_FOUND", "teaching activity not found");
        const activity = activityRows[0] as Record<string, unknown>;
        const contentVersion = Number(activity.content_version);
        if (contentVersion !== input.expectedVersion) {
          throw learningError("CONFLICT", "stale activity content version for checkpoint save");
        }
        if (activity.status === "completed") throw learningError("CONFLICT", "completed teaching activity cannot change its checkpoint");

        if (input.drafts) {
          const specRows = await tx`
            SELECT block_order FROM opening_teaching_activity_specs
            WHERE workspace_id = ${scope.workspaceId}
              AND activity_id = ${activityId}
            FOR SHARE`;
          const blockOrder = specRows[0]
            ? asBlockOrder((specRows[0] as Record<string, unknown>).block_order)
            : [];
          const present = new Set(blockOrder.map((b) => b.blockId));
          const lostBlockIds = input.drafts
            .map((d) => d.blockId)
            .filter((id) => !present.has(id));
          if (lostBlockIds.length) {
            return {
              ok: false as const,
              mismatch: "draft_anchor_lost" as const,
              lostBlockIds: [...new Set(lostBlockIds)],
            };
          }
        }

        const prev = (activity.checkpoint_json ?? {}) as Record<string, unknown>;
        const patch: {
          drafts?: TeachingDraftAnchor[];
          currentBlockId?: string | null;
          interactionParams?: Record<string, Record<string, unknown>>;
          openProblemIds?: string[];
        } = {};
        if (input.drafts !== undefined) patch.drafts = input.drafts;
        if (input.currentBlockId !== undefined) patch.currentBlockId = input.currentBlockId;
        if (input.interactionParams !== undefined) {
          patch.interactionParams = input.interactionParams;
        }
        if (input.openProblemIds !== undefined) patch.openProblemIds = input.openProblemIds;
        const nextCheckpoint = mergeCheckpointResumePatch(prev, patch);

        const updated = await tx`
          UPDATE opening_teaching_activities
          SET checkpoint_json = ${tx.json(nextCheckpoint as never)}, updated_at = now()
          WHERE id = ${activityId}
            AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND content_version = ${input.expectedVersion}
          RETURNING content_version, checkpoint_json`;
        if (!updated.length) throw learningError("CONFLICT", "checkpoint save raced");
        return {
          ok: true as const,
          contentVersion: Number((updated[0] as Record<string, unknown>).content_version),
          checkpointJson: (updated[0] as Record<string, unknown>).checkpoint_json as Record<
            string,
            unknown
          >,
        };
      });
    },

    async readRevision(
      scope: Scope,
      documentId: string,
      revisionNumber: number,
    ): Promise<RevisionRecord> {
      return library.getRevision({
        workspaceId: scope.workspaceId,
        documentId,
        revisionNumber,
      });
    },
  };
}

export type OpeningTeachingContentRepository = ReturnType<
  typeof createOpeningTeachingContentRepository
>;
