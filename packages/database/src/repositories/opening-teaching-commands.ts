import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { generateTeachingWorkedExample } from "./teaching-worked-example";
import { teachingQuestionText } from "./opening-teaching-question";
import { carryTeachingExampleExposure, generateOpeningStudyExposure, releaseOpeningStudyExposure, type OpeningStudyExposureInput } from "./opening-study-exposure";
import { assertOpeningCourseRouteCurrent } from "./opening-course-route-origin";
import type { JSONValue, Sql } from "postgres";
import type {
  ActivitySpecClientInit,
  Scope,
  TeachingBlockRef,
  TeachingCommandConflict,
  TeachingCommandLogEntry,
  TeachingCommandRequest,
  TeachingCommandResponse,
  TeachingCommandSuccess,
  TeachingDraftAnchor,
} from "@aistudy/contracts";
import {
  isTeachingPathKind,
  isTeachingRewriteKind,
  TEACHING_COMMAND_LOG_MAX,
  teachingQuestionInteractionSchema,
} from "@aistudy/contracts";
import {
  appendCommandLog,
  assertCommandAllowed,
  buildStructuredRewriteBlocks,
  buildWhyAssist,
  classifySkipSideEffects,
  createBranchFrame,
  draftsSurvivingBlockIds,
  findCommandLogByClientKey,
  fingerprintCommandIntent,
  mergeCheckpointPreservingPrefs,
  nextBlockIdAfter,
  popBranch,
  pushBranch,
  readBranchStack,
  readCommandLog,
  readSkippedBlockIds,
} from "@aistudy/domain";
import {
  assertOwnedActivity,
} from "./opening-teaching-activities";
import {
  admitLearningSources,
  learningError,
  learningIso,
  lockLearningOwner,
  lockWorkspaceLearningHistory,
} from "./opening-learning-facts";
import {
  createLibraryRepository,
  LibraryError,
  type RevisionRecord,
} from "./library";
import {
  createOpeningTeachingContentRepository,
  redactBlocksForClientInit,
  sanitizeCheckpointForRestore,
} from "./opening-teaching-content";

type ActivityRow = {
  id: string;
  status: string;
  workspace_id: string;
  owner_user_id: string;
  generate_status: string;
  content_version: number | string;
  path_version: number | string;
  checkpoint_json: Record<string, unknown> | null;
};

type SpecRow = {
  id: string;
  activity_id: string;
  teaching_unit_id: string;
  document_id: string;
  revision_number: number | string;
  block_order: TeachingBlockRef[] | unknown;
  source_refs: unknown;
  goals_json: unknown;
  verification_status: string;
  generation_config: unknown;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  workspace_id: string;
  owner_user_id: string;
};

function asBlockOrder(value: unknown): TeachingBlockRef[] {
  return Array.isArray(value) ? (value as TeachingBlockRef[]) : [];
}

function conflict(
  code: TeachingCommandConflict["conflict"],
  message: string,
  extras: Partial<TeachingCommandConflict> = {},
): TeachingCommandConflict {
  return {
    ok: false,
    conflict: code,
    message,
    ...extras,
  };
}

function mapSpecClientShape(spec: SpecRow, contentVersion: number, blocks: ActivitySpecClientInit["blocks"], checkpointJson: Record<string, unknown>): ActivitySpecClientInit {
  return {
    id: String(spec.id),
    activityId: String(spec.activity_id),
    teachingUnitId: String(spec.teaching_unit_id),
    documentId: String(spec.document_id),
    revisionNumber: Number(spec.revision_number),
    blockOrder: asBlockOrder(spec.block_order),
    sourceRefs: Array.isArray(spec.source_refs) ? (spec.source_refs as ActivitySpecClientInit["sourceRefs"]) : [],
    goals: Array.isArray(spec.goals_json) ? (spec.goals_json as ActivitySpecClientInit["goals"]) : [],
    verificationStatus: spec.verification_status as ActivitySpecClientInit["verificationStatus"],
    generationConfig:
      spec.generation_config && typeof spec.generation_config === "object"
        ? (spec.generation_config as ActivitySpecClientInit["generationConfig"])
        : {},
    version: Number(spec.version),
    createdAt: learningIso(spec.created_at)!,
    updatedAt: learningIso(spec.updated_at)!,
    blocks,
    contentVersion,
    checkpointJson,
  };
}

type ReplayStore = Record<string, TeachingCommandSuccess>;

function readReplayStore(checkpoint: Record<string, unknown>): ReplayStore {
  const raw = checkpoint.commandReplay;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as ReplayStore;
}

function writeReplayStore(
  checkpoint: Record<string, unknown>,
  clientKey: string,
  success: TeachingCommandSuccess,
): Record<string, unknown> {
  const prev = readReplayStore(checkpoint);
  const next: ReplayStore = { ...prev, [clientKey]: success };
  // Bound replay map roughly with command log ring.
  const keys = Object.keys(next);
  if (keys.length > TEACHING_COMMAND_LOG_MAX) {
    for (const k of keys.slice(0, keys.length - TEACHING_COMMAND_LOG_MAX)) {
      delete next[k];
    }
  }
  return { ...checkpoint, commandReplay: next };
}

export function createOpeningTeachingCommandsRepository(sql: Sql) {
  const contentRepo = createOpeningTeachingContentRepository(sql);

  return {
    /**
     * Execute a teaching command with content/path CAS. Never LWW.
     * Skip does not write learning observations (classifySkipSideEffects locked).
     */
    async executeCommand(
      scope: Scope,
      activityId: string,
      request: TeachingCommandRequest,
    ): Promise<TeachingCommandResponse> {
      // Domain lock: skip must not touch observations — keep symbol referenced for tests.
      void classifySkipSideEffects();

      const intentFingerprint = request.kind === "example"
        ? JSON.stringify([fingerprintCommandIntent(request), request.expectedRevisionNumber ?? null])
        : fingerprintCommandIntent(request);

      try {
        return await sql.begin(async (tx) => {
          await lockWorkspaceLearningHistory(tx, scope);
          await lockLearningOwner(tx, scope);

          const activityRows = await tx`
            SELECT * FROM opening_teaching_activities
            WHERE id = ${activityId}
              AND workspace_id = ${scope.workspaceId}
              AND owner_user_id = ${scope.ownerUserId}
            FOR UPDATE`;
          if (!activityRows.length) {
            throw learningError("NOT_FOUND", "teaching activity not found");
          }
          const activity = activityRows[0] as unknown as ActivityRow;
          const contentVersion = Number(activity.content_version);
          const pathVersion = Number(activity.path_version);
          const checkpoint = (activity.checkpoint_json ?? {}) as Record<string, unknown>;
          const generateStatus = String(activity.generate_status);

          // Explicit example operations replay before CAS; a lost response must not
          // create a second body. Other commands retain their existing semantics.
          if (request.kind === "example") {
            const replay = findCommandLogByClientKey(readCommandLog(checkpoint), request.clientKey, intentFingerprint);
            if (replay.hit === "mismatch") return conflict("client_key_intent_mismatch", "example operation intent changed");
            if (replay.hit === "replay") {
              const stored = readReplayStore(checkpoint)[request.clientKey];
              if (stored) return { ...stored, replayed: true };
              return conflict("validation", "此操作已执行，请重新读取已保存的例题；不会自动再生成。");
            }
            // Durable receipt survives the bounded command replay ring.
            const [released] = await tx`SELECT id FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}
              AND owner_user_id=${scope.ownerUserId} AND release_key=${`teaching-example:${createHash("sha256").update(JSON.stringify([activity.id, request.clientKey])).digest("hex")}`}`;
            if (released) return conflict("validation", "此操作已执行，请重新读取已保存的例题；不会自动再生成。");
          }
          if (contentVersion !== request.expectedVersion) {
            return conflict("stale_content_version", "activity content_version mismatch; reread clientInit", {
              currentContentVersion: contentVersion,
              currentPathVersion: pathVersion,
            });
          }
          if (
            request.expectedPathVersion != null &&
            request.expectedPathVersion !== pathVersion
          ) {
            return conflict("stale_path_version", "activity path_version mismatch; reread clientInit", {
              currentContentVersion: contentVersion,
              currentPathVersion: pathVersion,
            });
          }

          const commandLog = readCommandLog(checkpoint);
          const replayLookup = findCommandLogByClientKey(
            commandLog,
            request.clientKey,
            intentFingerprint,
          );
          if (replayLookup.hit === "mismatch") {
            return conflict(
              "client_key_intent_mismatch",
              "same clientKey used with a different command intent; allocate a new clientKey",
              { currentContentVersion: contentVersion, currentPathVersion: pathVersion },
            );
          }
          if (replayLookup.hit === "replay") {
            const stored = readReplayStore(checkpoint)[request.clientKey];
            if (stored && stored.ok === true) {
              return { ...stored, replayed: true };
            }
            // Soft-idempotent without stored payload: success stub from log entry.
            return {
              ok: true as const,
              kind: request.kind,
              activityId,
              contentVersion: replayLookup.entry.contentVersionAfter ?? contentVersion,
              pathVersion: replayLookup.entry.pathVersionAfter ?? pathVersion,
              revisionNumber: replayLookup.entry.revisionNumberAfter,
              checkpointJson: sanitizeCheckpointForRestore(checkpoint),
              replayed: true,
            };
          }

          if (activity.status === "completed") throw learningError("CONFLICT", "completed teaching activity cannot accept new commands");
          const specRows = await tx`
            SELECT * FROM opening_teaching_activity_specs
            WHERE workspace_id = ${scope.workspaceId}
              AND activity_id = ${activityId}
            FOR UPDATE`;
          if (!specRows.length) {
            return conflict("validation", "activity has no published ActivitySpec", {
              currentContentVersion: contentVersion,
              currentPathVersion: pathVersion,
            });
          }
          const spec = specRows[0] as unknown as SpecRow;
          let blockOrder = asBlockOrder(spec.block_order);
          const presentIds = new Set(blockOrder.map((b) => b.blockId));
          const branchStack = readBranchStack(checkpoint);

          if (request.targetBlockId && !presentIds.has(request.targetBlockId)) {
            return conflict("block_not_in_spec", "targetBlockId is not in current ActivitySpec", {
              currentContentVersion: contentVersion,
              currentPathVersion: pathVersion,
              currentRevisionNumber: Number(spec.revision_number),
            });
          }

          const allowed = assertCommandAllowed({
            activity: { generateStatus, contentVersion, pathVersion },
            kind: request.kind,
            blockId: request.blockId,
            blockIdsInSpec: presentIds,
            branchStack,
          });
          if (!allowed.ok) {
            return conflict(allowed.conflict, allowed.message, {
              currentContentVersion: contentVersion,
              currentPathVersion: pathVersion,
              currentRevisionNumber: Number(spec.revision_number),
            });
          }

          if (request.kind === "example" && (!blockOrder.some(block => block.blockId === request.blockId && block.role === "example" && block.blockType === "example")
            || ["unknown", "failed"].includes(generateStatus))) {
            return conflict("validation", "未生成新例题：请选择已保存的例题；生成状态不明确时不会自动重发。", {
              currentContentVersion: contentVersion, currentPathVersion: pathVersion, currentRevisionNumber: Number(spec.revision_number),
            });
          }

          if (
            request.expectedRevisionNumber != null &&
            request.expectedRevisionNumber !== Number(spec.revision_number)
          ) {
            return conflict("stale_revision", "pinned library revision mismatch", {
              currentContentVersion: contentVersion,
              currentPathVersion: pathVersion,
              currentRevisionNumber: Number(spec.revision_number),
            });
          }

          const at = new Date().toISOString();
          let nextContentVersion = contentVersion;
          let nextPathVersion = pathVersion;
          let nextRevisionNumber = Number(spec.revision_number);
          let nextCheckpoint = { ...checkpoint };
          let assist: TeachingCommandSuccess["assist"];
          let nextSpec = spec;
          let exampleQuestionBlocks: TeachingBlockRef[] = [];
          let carriedHelp: Array<{ id: string; blockId: string }> = [];
          let publicationBlocks: JSONValue = null;

          if (request.kind === "why" || request.kind === "confused") {
            const ref = blockOrder.find((b) => b.blockId === request.blockId);
            assist = request.kind === "confused" ? { kind: "confused", summary: "已记下这里需要讲清楚。你可以查看提示，或选中具体一句继续提问。" } : buildWhyAssist({
              blockId: request.blockId!,
              prompt: request.prompt,
              blockType: ref?.blockType,
            });
            const entry: TeachingCommandLogEntry = {
              clientKey: request.clientKey,
              kind: request.kind,
              blockId: request.blockId,
              at,
              result: "ok",
              contentVersionAfter: nextContentVersion,
              pathVersionAfter: nextPathVersion,
              revisionNumberAfter: nextRevisionNumber,
              intentFingerprint,
            };
            nextCheckpoint = mergeCheckpointPreservingPrefs(nextCheckpoint, {
              commandLog: appendCommandLog(commandLog, entry),
            });
            if (request.kind === "confused") {
              // Keep the per-session count after the bounded command log rotates.
              const count = checkpoint.confusionCount;
              nextCheckpoint.confusionCount = (typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0) + 1;
              nextCheckpoint.lastConfusion = { at, blockId: request.blockId, contentVersion };
            }
          } else if (isTeachingRewriteKind(request.kind)) {
            const pinnedRev = Number(spec.revision_number);
            const documentId = String(spec.document_id);

            // Load prior revision via library (same sql; outside nested write).
            let prior: RevisionRecord;
            try {
              prior = await createLibraryRepository(tx as unknown as Sql).getRevision({
                workspaceId: scope.workspaceId,
                documentId,
                revisionNumber: pinnedRev,
              });
            } catch (error) {
              if (error instanceof LibraryError && error.code === "NOT_FOUND") {
                return conflict("stale_revision", "pinned library revision not found", {
                  currentContentVersion: contentVersion,
                  currentPathVersion: pathVersion,
                  currentRevisionNumber: pinnedRev,
                });
              }
              throw error;
            }

            const priorBlocks = prior.blocks.map(b => ({ id: b.id, type: b.type, content: b.content as Record<string, unknown> }));
            let newBlocks = priorBlocks;
            if (request.kind === "example") {
              await assertOpeningCourseRouteCurrent(tx, scope, activityId);
              const [unit] = await tx`SELECT current_revision_number FROM opening_teaching_units
                WHERE id=${String(spec.teaching_unit_id)} AND workspace_id=${scope.workspaceId}
                  AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
              if (!unit || Number(unit.current_revision_number) !== pinnedRev || Number(spec.version) !== contentVersion) {
                return conflict("stale_revision", "教学正文绑定已变化，请重新读取。");
              }
              const [owned] = await tx`SELECT source_ids FROM opening_teaching_activities WHERE id=${activityId}`;
              const sources = await admitLearningSources(tx, scope, (owned?.source_ids ?? []) as string[], { recordVersions: false });
              const versions = new Map(sources.map(source => [String(source.id), Number(source.version)]));
              const refs = Array.isArray(spec.source_refs) ? spec.source_refs as Array<{sourceId: string; version?: string | number | null}> : [];
              if ([...versions.keys()].some(id => !refs.some(ref => ref.sourceId === id))
                || refs.some(ref => ref.version == null || versions.get(ref.sourceId) !== Number(ref.version))) {
                return conflict("stale_revision", "来源版本已变化，未发布新例题。");
              }
              const target = priorBlocks.find(block => block.id === request.blockId);
              const ref = blockOrder.find(block => block.blockId === request.blockId);
              const body = target?.content.text;
              const history = await tx`SELECT blocks FROM library_revisions WHERE workspace_id=${scope.workspaceId}
                AND document_id=${documentId} AND revision_number<=${pinnedRev}`;
              const previousBodies = history.flatMap(row => (row.blocks as RevisionRecord["blocks"])
                .map(block => typeof block.content.text === "string" ? block.content.text : ""));
              const generated = target?.type === "example" && ref?.role === "example" && typeof body === "string"
                ? generateTeachingWorkedExample(body, previousBodies) : null;
              if (!generated || priorBlocks.length >= 500 || blockOrder.length >= 500) {
                return conflict("validation", "未生成新例题：目前仅支持明确的分数加法、多项式求导/切线、多项式定积分例题；输入不受支持或本题族新题已用完。原题与学习记录保持不变。", {
                  currentContentVersion: contentVersion,
                  currentPathVersion: pathVersion,
                  currentRevisionNumber: Number(spec.revision_number),
                });
              }
              const id = randomUUID();
              newBlocks = [...priorBlocks, { id, type: "example", content: {
                ...generated, generated: true, workedExampleOf: { blockId: request.blockId!, contentVersion,
                  revisionNumber: pinnedRev, sourceRefs: spec.source_refs, skillLabel: generated.skillLabel,
                  clientKey: request.clientKey },
              } }];
              // Match readTeachingQuestionForAttempt's ref/body admission, not
              // role=prompt alone: teach/meta/example roles can hold saved questions.
              // Never turn an answer-key/solution body into a question anchor.
              exampleQuestionBlocks = blockOrder.filter(block => {
                if (block.role === "answer_key" || !(block.role === "prompt" || ["prompt", "question"].includes(block.blockType))) return false;
                const saved = priorBlocks.find(body => body.id === block.blockId);
                return saved !== undefined && ["prompt", "question"].includes(saved.type)
                  && (saved.content.interaction === undefined || teachingQuestionInteractionSchema.safeParse(saved.content.interaction).success)
                  && teachingQuestionText(saved.content) !== null;
              });
              // Append, never replace the original prompt/example or its drafts.
              blockOrder = [...blockOrder, { blockId: id, blockType: "example", role: "example",
                position: Math.max(-1, ...blockOrder.map(block => block.position)) + 1 }];
            } else {
              newBlocks = buildStructuredRewriteBlocks(priorBlocks, {
                kind: request.kind, blockId: request.blockId!, prompt: request.prompt,
              });
              const withoutRewrite = (blocks: typeof priorBlocks) => blocks.map(block => {
                if (block.id !== request.blockId) return block;
                const { rewriteOf: _rewrite, ...content } = block.content;
                return { ...block, content };
              });
              // Compare actual saved content/context, not rewriteOf's claim. The
              // receipt's server-only binding proves the prior source publication
              // even if no attempt/item has ever been issued there.
              if (isDeepStrictEqual(withoutRewrite(priorBlocks), withoutRewrite(newBlocks))) {
                const receipts = await tx`SELECT h.id,h.context_anchor,h.release_intent FROM opening_help_exposures h
                  WHERE h.workspace_id=${scope.workspaceId} AND h.owner_user_id=${scope.ownerUserId}
                    AND h.activity_id=${activityId} AND h.delivered=TRUE AND h.released_at IS NOT NULL
                    AND h.kind='solution' AND h.level='revealed' AND h.release_key LIKE 'teaching-example:%'
                    AND h.attempt_id IS NULL AND h.problem_id IS NULL AND h.item_version_id IS NULL
                    AND h.context_anchor->>'contentVersion'=${String(contentVersion)}`;
                for (const receipt of receipts) {
                  const anchor = receipt.context_anchor as OpeningStudyExposureInput["contextAnchor"];
                  const binding = (receipt.release_intent as OpeningStudyExposureInput | null)?.teachingPublication;
                  if (!binding || anchor.activityId !== activity.id || anchor.contentVersion !== contentVersion
                    || binding.documentId !== documentId || binding.revisionNumber !== pinnedRev
                    || binding.teachingUnitId !== String(spec.teaching_unit_id)
                    || !isDeepStrictEqual(binding.blocks, prior.blocks)
                    || !isDeepStrictEqual(binding.sourceRefs, spec.source_refs)
                    || !isDeepStrictEqual(binding.blockOrder, blockOrder)) continue;
                  const ref = blockOrder.find(block => block.blockId === anchor.blockId);
                  const body = priorBlocks.find(block => block.id === anchor.blockId);
                  if (!ref || ref.role === "answer_key" || !(ref.role === "prompt" || ["prompt", "question"].includes(ref.blockType))
                    || !body || !["prompt", "question"].includes(body.type) || !teachingQuestionText(body.content)
                    || body.content.interaction !== undefined && !teachingQuestionInteractionSchema.safeParse(body.content.interaction).success) continue;
                  carriedHelp.push({ id: String(receipt.id), blockId: ref.blockId });
                }
                if (carriedHelp.length) {
                  const [owned] = await tx`SELECT source_ids FROM opening_teaching_activities WHERE id=${activityId}`;
                  const sources = await admitLearningSources(tx, scope, (owned?.source_ids ?? []) as string[], { recordVersions: false });
                  const refs = Array.isArray(spec.source_refs) ? spec.source_refs as Array<{ sourceId: string; version?: string | number | null }> : [];
                  const versions = new Map(sources.map(source => [String(source.id), Number(source.version)]));
                  if ([...versions.keys()].some(id => !refs.some(ref => ref.sourceId === id))
                    || refs.some(ref => ref.version == null || versions.get(ref.sourceId) !== Number(ref.version))) carriedHelp = [];
                }
              }
            }

            // Draft preserve: surviving blockIds only; lost → draft_anchor_lost (no LWW drop).
            const presentAfter = new Set(newBlocks.map((b) => b.id));
            // blockOrder ids should still match M1 clone (no order change).
            for (const ref of blockOrder) presentAfter.add(ref.blockId);
            const { kept, lostBlockIds } = draftsSurvivingBlockIds(
              checkpoint.drafts,
              presentAfter,
            );
            if (lostBlockIds.length) {
              return conflict(
                "draft_anchor_lost",
                "rewrite would drop draft anchors for missing blockIds",
                {
                  currentContentVersion: contentVersion,
                  currentPathVersion: pathVersion,
                  currentRevisionNumber: pinnedRev,
                  lostBlockIds,
                },
              );
            }

            try {
              await createLibraryRepository(sql).updateDocumentInTx(tx, {
                workspaceId: scope.workspaceId,
                documentId,
                expectedRevisionNumber: pinnedRev,
                blocks: newBlocks,
                reason: `teaching_command:${request.kind}`,
              });
            } catch (error) {
              if (error instanceof LibraryError && error.code === "CONFLICT") {
                return conflict("stale_revision", error.message, {
                  currentContentVersion: contentVersion,
                  currentPathVersion: pathVersion,
                  currentRevisionNumber: pinnedRev,
                });
              }
              throw error;
            }

            publicationBlocks = newBlocks.map((block, position) => ({ ...block, position })) as JSONValue;
            nextRevisionNumber = pinnedRev + 1;
            nextContentVersion = contentVersion + 1;

            const upserted = await tx`
              UPDATE opening_teaching_activity_specs
              SET revision_number = ${nextRevisionNumber},
                  block_order = ${tx.json(blockOrder as never)},
                  version = ${nextContentVersion},
                  updated_at = now()
              WHERE workspace_id = ${scope.workspaceId}
                AND activity_id = ${activityId}
              RETURNING *`;
            if (!upserted.length) {
              throw learningError("CONFLICT", "activity spec pin raced");
            }
            nextSpec = upserted[0] as unknown as SpecRow;

            await tx`
              UPDATE opening_teaching_units
              SET current_revision_number = GREATEST(current_revision_number, ${nextRevisionNumber}),
                  updated_at = now()
              WHERE id = ${String(spec.teaching_unit_id)}
                AND workspace_id = ${scope.workspaceId}`;

            const entry: TeachingCommandLogEntry = {
              clientKey: request.clientKey,
              kind: request.kind,
              blockId: request.blockId,
              at,
              result: "ok",
              contentVersionAfter: nextContentVersion,
              pathVersionAfter: nextPathVersion,
              revisionNumberAfter: nextRevisionNumber,
              intentFingerprint,
            };
            nextCheckpoint = mergeCheckpointPreservingPrefs(nextCheckpoint, {
              drafts: kept as TeachingDraftAnchor[],
              commandLog: appendCommandLog(commandLog, entry),
              currentBlockId: request.kind === "example" ? blockOrder[blockOrder.length - 1]!.blockId
                : typeof checkpoint.currentBlockId === "string" ? checkpoint.currentBlockId : request.blockId!,
            });
          } else if (request.kind === "skip") {
            const skipped = new Set(readSkippedBlockIds(checkpoint));
            skipped.add(request.blockId!);
            const nextCursor = nextBlockIdAfter(
              blockOrder,
              request.blockId!,
              request.targetBlockId,
            );
            nextPathVersion = pathVersion + 1;
            const entry: TeachingCommandLogEntry = {
              clientKey: request.clientKey,
              kind: "skip",
              blockId: request.blockId,
              at,
              result: "ok",
              contentVersionAfter: nextContentVersion,
              pathVersionAfter: nextPathVersion,
              revisionNumberAfter: nextRevisionNumber,
              intentFingerprint,
            };
            nextCheckpoint = mergeCheckpointPreservingPrefs(nextCheckpoint, {
              skippedBlockIds: [...skipped],
              currentBlockId: nextCursor,
              commandLog: appendCommandLog(commandLog, entry),
            });
          } else if (request.kind === "branch") {
            const frame = createBranchFrame({
              fromBlockId: request.blockId!,
              resumeBlockId: request.blockId,
              contentVersion,
              pathVersion,
              label: request.branchLabel,
              createdAt: at,
            });
            const nextStack = pushBranch(branchStack, frame);
            nextPathVersion = pathVersion + 1;
            const entry: TeachingCommandLogEntry = {
              clientKey: request.clientKey,
              kind: "branch",
              blockId: request.blockId,
              at,
              result: "ok",
              contentVersionAfter: nextContentVersion,
              pathVersionAfter: nextPathVersion,
              revisionNumberAfter: nextRevisionNumber,
              intentFingerprint,
            };
            nextCheckpoint = mergeCheckpointPreservingPrefs(nextCheckpoint, {
              branchStack: nextStack,
              currentBlockId: request.targetBlockId ?? request.blockId!,
              commandLog: appendCommandLog(commandLog, entry),
            });
          } else if (request.kind === "return") {
            const popped = popBranch(branchStack);
            if ("empty" in popped) {
              return conflict("branch_stack_empty", "no branch frame to return to", {
                currentContentVersion: contentVersion,
                currentPathVersion: pathVersion,
              });
            }
            nextPathVersion = pathVersion + 1;
            const resume =
              popped.frame.resumeBlockId ?? popped.frame.fromBlockId;
            const entry: TeachingCommandLogEntry = {
              clientKey: request.clientKey,
              kind: "return",
              blockId: request.blockId,
              at,
              result: "ok",
              contentVersionAfter: nextContentVersion,
              pathVersionAfter: nextPathVersion,
              revisionNumberAfter: nextRevisionNumber,
              intentFingerprint,
            };
            nextCheckpoint = mergeCheckpointPreservingPrefs(nextCheckpoint, {
              branchStack: popped.nextStack,
              currentBlockId: resume,
              commandLog: appendCommandLog(commandLog, entry),
            });
          } else {
            return conflict("validation", `unsupported kind: ${request.kind}`);
          }

          // Persist activity versions + checkpoint (CAS content_version still held).
          const bumpedContent = isTeachingRewriteKind(request.kind);
          const bumpedPath = isTeachingPathKind(request.kind);

          const updated = bumpedContent
            ? await tx`
                UPDATE opening_teaching_activities
                SET content_version = ${nextContentVersion},
                    checkpoint_json = ${tx.json(nextCheckpoint as never)},
                    updated_at = now()
                WHERE id = ${activityId}
                  AND workspace_id = ${scope.workspaceId}
                  AND owner_user_id = ${scope.ownerUserId}
                  AND content_version = ${contentVersion}
                RETURNING content_version, path_version, checkpoint_json`
            : bumpedPath
              ? await tx`
                UPDATE opening_teaching_activities
                SET path_version = ${nextPathVersion},
                    checkpoint_json = ${tx.json(nextCheckpoint as never)},
                    updated_at = now()
                WHERE id = ${activityId}
                  AND workspace_id = ${scope.workspaceId}
                  AND owner_user_id = ${scope.ownerUserId}
                  AND content_version = ${contentVersion}
                  AND path_version = ${pathVersion}
                RETURNING content_version, path_version, checkpoint_json`
              : await tx`
                UPDATE opening_teaching_activities
                SET checkpoint_json = ${tx.json(nextCheckpoint as never)},
                    updated_at = now()
                WHERE id = ${activityId}
                  AND workspace_id = ${scope.workspaceId}
                  AND owner_user_id = ${scope.ownerUserId}
                  AND content_version = ${contentVersion}
                RETURNING content_version, path_version, checkpoint_json`;

          if (!updated.length) {
            // Throw to roll back library/spec writes as well as activity CAS.
            throw learningError("CONFLICT", "activity version raced; reread clientInit");
          }
          if (request.kind === "example") {
            const generatedBlock = blockOrder[blockOrder.length - 1]!;
            // A demonstrated solution is assistance, not a fresh independent item.
            // Pin receipts to this publication's questions as well as the example:
            // changing surrounding context must not wash help away (#382).
            const exposed = [generatedBlock, ...exampleQuestionBlocks];
            for (const block of exposed) {
              const receipt = await generateOpeningStudyExposure(tx, scope, {
                releaseKey: `teaching-example:${createHash("sha256").update(JSON.stringify([activity.id, request.clientKey])).digest("hex")}${block.blockId === generatedBlock.blockId ? "" : `:${createHash("sha256").update(block.blockId).digest("hex")}`}`,
                contextAnchor: { activityId: activity.id, blockId: block.blockId, contentVersion: nextContentVersion, purpose: "learning_help" },
                origin: "assistant", kind: "solution", level: "revealed", supportDomain: "unknown", initiatedBy: "user",
                teachingPublication: { documentId: String(nextSpec.document_id), revisionNumber: nextRevisionNumber,
                  teachingUnitId: String(nextSpec.teaching_unit_id), blocks: publicationBlocks,
                  sourceRefs: nextSpec.source_refs as JSONValue, blockOrder: blockOrder as JSONValue },
              });
              await releaseOpeningStudyExposure(tx, scope, receipt.id);
            }
          }

          for (const receipt of carriedHelp) {
            await carryTeachingExampleExposure(tx, scope, receipt.id, {
              releaseKey: `teaching-example:carry:${activity.id}:${nextContentVersion}:${receipt.blockId}`,
              contextAnchor: { activityId: activity.id, blockId: receipt.blockId, contentVersion: nextContentVersion, purpose: "learning_help" },
              origin: "assistant", kind: "solution", level: "revealed", supportDomain: "unknown", initiatedBy: "user",
              teachingPublication: { documentId: String(nextSpec.document_id), revisionNumber: nextRevisionNumber,
                teachingUnitId: String(nextSpec.teaching_unit_id), blocks: publicationBlocks,
                sourceRefs: nextSpec.source_refs as JSONValue, blockOrder: blockOrder as JSONValue },
            });
          }

          const finalContentVersion = Number(
            (updated[0] as Record<string, unknown>).content_version,
          );
          const finalPathVersion = Number(
            (updated[0] as Record<string, unknown>).path_version,
          );
          let finalCheckpoint = (updated[0] as Record<string, unknown>)
            .checkpoint_json as Record<string, unknown>;

          // Build success; attach clientInit (redacted). For rewrite use nextSpec revision.
          const clientInit = await (async () => {
            try {
              const revision = await createLibraryRepository(tx as unknown as Sql).getRevision({
                workspaceId: scope.workspaceId,
                documentId: String(nextSpec.document_id),
                revisionNumber: Number(nextSpec.revision_number),
              });
              const blocks = redactBlocksForClientInit(
                asBlockOrder(nextSpec.block_order),
                revision.blocks,
              );
              return mapSpecClientShape(
                { ...nextSpec, revision_number: Number(nextSpec.revision_number), version: finalContentVersion },
                finalContentVersion,
                blocks,
                sanitizeCheckpointForRestore(finalCheckpoint),
              );
            } catch (error) {
              if (request.kind === "example") throw error;
              return undefined;
            }
          })();

          const success: TeachingCommandSuccess = {
            ok: true,
            kind: request.kind,
            activityId,
            contentVersion: finalContentVersion,
            pathVersion: finalPathVersion,
            revisionNumber: isTeachingRewriteKind(request.kind)
              ? nextRevisionNumber
              : undefined,
            checkpointJson: sanitizeCheckpointForRestore(finalCheckpoint),
            clientInit,
            replayed: false,
            assist,
          };

          // Persist soft-idempotent replay payload (best-effort second write in same txn).
          finalCheckpoint = writeReplayStore(finalCheckpoint, request.clientKey, {
            ...success,
            // Avoid nesting huge clientInit in replay map — reread on replay is OK;
            // keep versions + assist + checkpoint.
            clientInit: undefined,
          });
          await tx`
            UPDATE opening_teaching_activities
            SET checkpoint_json = ${tx.json(finalCheckpoint as never)}, updated_at = now()
            WHERE id = ${activityId}
              AND workspace_id = ${scope.workspaceId}
              AND owner_user_id = ${scope.ownerUserId}`;

          return {
            ...success,
            checkpointJson: sanitizeCheckpointForRestore(finalCheckpoint),
          };
        });
      } catch (error) {
        if (error instanceof LibraryError) {
          if (error.code === "CONFLICT") {
            return conflict("stale_revision", error.message);
          }
          if (error.code === "VALIDATION") {
            return conflict("validation", error.message);
          }
        }
        throw error;
      }
    },

    /** Auth scope check used by route before execute (NOT_FOUND for other owner). */
    async assertOwned(scope: Scope, activityId: string) {
      return assertOwnedActivity(sql, scope, activityId);
    },

    /** Test seam: content repo getClientInit after command. */
    async getClientInit(scope: Scope, activityId: string) {
      return contentRepo.getClientInit(scope, activityId);
    },
  };
}

export type OpeningTeachingCommandsRepository = ReturnType<
  typeof createOpeningTeachingCommandsRepository
>;

/** Pure helper exported for unit tests — intent equality without DB. */
export function sameCommandIntent(
  left: TeachingCommandRequest,
  right: TeachingCommandRequest,
): boolean {
  return isDeepStrictEqual(
    fingerprintCommandIntent(left),
    fingerprintCommandIntent(right),
  );
}

export { classifySkipSideEffects };
