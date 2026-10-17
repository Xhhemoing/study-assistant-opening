import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
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
      content: body?.content ?? null,
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

export function createOpeningTeachingContentRepository(sql: Sql) {
  const library = createLibraryRepository(sql);

  return {
    /** Never unlock a different prompt or a changed revision using an old answer. */
    async getSubmittedAnswerKey(scope: Scope, activityId: string, blockId: string, attemptId: string): Promise<TeachingAnswerKey> {
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const activities = await tx`SELECT a.* FROM opening_teaching_activities a
          JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=${scope.ownerUserId}
          WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} FOR SHARE OF a`;
        const activity = activities[0];
        if (!activity) throw learningError("NOT_FOUND", "teaching activity not found");
        const sourceIds = activity.source_ids as string[];
        const admitted = await admitLearningSources(tx, scope, sourceIds);
        const currentVersions = new Map(admitted.map((source) => [String(source.id), Number(source.version)]));
        const attempts = await tx`SELECT submitted_at,create_intent,source_versions FROM opening_learning_attempts
          WHERE id=${attemptId} AND activity_id=${activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        const attempt = attempts[0];
        if (!attempt?.submitted_at) throw learningError("NOT_FOUND", "submitted teaching attempt not found");
        const intent = attempt.create_intent as { teachingBlock?: { blockId?: unknown; contentVersion?: unknown } };
        if (intent.teachingBlock?.blockId !== blockId) throw learningError("VALIDATION", "attempt does not belong to this teaching question");
        if (intent.teachingBlock.contentVersion !== Number(activity.content_version)) throw learningError("CONFLICT", "teaching content changed; the submitted answer belongs to an earlier version");
        const specs = await tx`SELECT * FROM opening_teaching_activity_specs WHERE activity_id=${activityId}
          AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        if (!specs[0]) throw learningError("NOT_FOUND", "teaching content not found");
        const spec = mapSpec(specs[0]);
        if (spec.version !== intent.teachingBlock.contentVersion) throw learningError("CONFLICT", "teaching specification version changed");
        const capturedVersions = attempt.source_versions as Record<string, number>;
        for (const ref of spec.sourceRefs) {
          const version = ref.version == null ? NaN : Number(ref.version);
          if (Number.isInteger(version) && (currentVersions.get(ref.sourceId) !== version || capturedVersions[ref.sourceId] !== version)) throw learningError("CONFLICT", "teaching reference material version changed; reread the teaching content");
        }
        const ordered = [...spec.blockOrder].sort((a, b) => a.position - b.position);
        const index = ordered.findIndex((block) => block.blockId === blockId && (block.role === "prompt" || block.blockType === "question" || block.blockType === "prompt"));
        const following = index < 0 ? undefined : ordered[index + 1];
        if (!following || !isAnswerKeyBlock(following.blockType, following.role)) return { answer: null, referenceSourceId: null };
        const revisions = await tx`SELECT blocks FROM library_revisions WHERE workspace_id=${scope.workspaceId}
          AND document_id=${spec.documentId} AND revision_number=${spec.revisionNumber}`;
        if (!revisions[0]) throw learningError("NOT_FOUND", "teaching revision not found");
        const revision = revisions[0] as { blocks: Array<{ id: string; content: Record<string, unknown> }> };
        const block = revision.blocks.find((row) => row.id === following.blockId);
        const body = block?.content;
        const answer = body && [body.text, body.markdown, body.answer, body.solution].find((value): value is string => typeof value === "string");
        const ownCitations = new Set(Array.isArray(body?.citedChunkIds)
          ? body.citedChunkIds.filter((id): id is string => typeof id === "string") : []);
        const candidates = spec.sourceRefs.filter((ref) => ref.chunkId && ownCitations.has(ref.chunkId)
          && ref.version != null && Number.isInteger(Number(ref.version))
          && capturedVersions[ref.sourceId] === Number(ref.version) && currentVersions.get(ref.sourceId) === Number(ref.version));
        const chunks = candidates.length ? await tx`SELECT id,source_id,source_version FROM opening_source_chunks
          WHERE workspace_id=${scope.workspaceId} AND id::text=ANY(${candidates.map(ref => ref.chunkId!)}::text[])
          FOR SHARE` : [];
        const reference = candidates.find(ref => chunks.some(chunk => String(chunk.id) === ref.chunkId
          && String(chunk.source_id) === ref.sourceId && Number(chunk.source_version) === Number(ref.version)));
        return { answer: answer?.slice(0, 20_000) ?? null, referenceSourceId: reference?.sourceId ?? null };
      });
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

    /**
     * Publish / upsert current ActivitySpec and bump activity.content_version with CAS.
     * Soft-idempotent: if already at expectedVersion+1 AND sameSpecGraph → success.
     */
    async publishActivitySpec(
      scope: Scope,
      input: ActivitySpecPublishInput,
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
        if (currentContentVersion !== input.expectedVersion) {
          throw learningError("CONFLICT", "stale activity content version");
        }
        if (activity.status === "completed") throw learningError("CONFLICT", "completed teaching activity cannot publish new content");

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
          SET content_version = ${newVersion}, updated_at = now()
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
