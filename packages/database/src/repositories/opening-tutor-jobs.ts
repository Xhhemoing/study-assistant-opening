import { appendOpeningStudyIntentInTx, createOpeningStudyIntentRepository, readOpeningStudyIntentInTx } from "./opening-study-intent-events";
import { composerMessageText, parseExplicitStudyMessage, DEFAULT_STUDY_SESSION_INTENT, studyIntentForMessage, tutorFailureForDisplay, TUTOR_STALE_MESSAGE, localDateKeyInZone, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { isDeepStrictEqual } from "node:util";
import { openingCanonicalLanguageQuestion } from "./opening-study-context";
import { readTutorAttemptContext, assertTutorAttemptContext, tutorAttemptFence, tutorAttemptFenceSchema, type TutorAttemptFence, type TutorAttemptContext, type TutorAttemptContextTarget } from "./opening-tutor-attempt-context";
export { tutorAttemptFence, tutorAttemptFenceSchema } from "./opening-tutor-attempt-context";
export type { TutorAttemptContext, TutorAttemptFence } from "./opening-tutor-attempt-context";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { generateOpeningStudyExposure, releaseOpeningStudyExposure, type OpeningStudyExposureInput } from "./opening-study-exposure";
import { insertOpeningDeliveredHelp } from "./opening-learning-help";
import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { createOpeningCourseReadySourcesRepository } from "./opening-course-ready-sources";
import { courseSourcePurposeAllows, helpInputSnapshotSchema, openingMaterialPurposePinSchema, type CourseSourcePurpose, type HelpInputSnapshot, type OpeningMaterialPurposePin } from "@aistudy/contracts";
import { TERMINAL_TURN_STATUSES, terminalTurnStatusForJobError, systemQueryReceiptSchema, type Citation, type SystemQueryReceipt, type StudyContextAnchor, type ComposerPurpose, type StudyIntentEvent } from "@aistudy/contracts";
import { contextSourceRefsIncluded, mergeContextSourceRefs, turnContextSourceRefs } from "./opening-context-provenance";
import type { OpeningScope } from "./opening-sources";
import type { ContextSourceRef } from "./opening-context-provenance";
import { loadTutorHistory, loadTutorHistoryContext, type TutorHistoryPurpose } from "./opening-tutor-history";
import {
  fenceCancelledOpeningTutorStream, isUnconfirmedStreamSealError, markFallbackStreamSealAttempted,
} from "./opening-tutor-stream-fence";

/** Terminal job error; nextAction "clarify" routes a refusal to the Clarify path (LAB-A01). */
export type OpeningTutorJobError = { message: string; code?: string; nextAction?: "clarify" };

export type OpeningTutorJobRecord = {
  id: string;
  workspaceId: string;
  ownerUserId?: string;
  conversationId: string;
  userTurnId: string;
  assistantTurnId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
  mode: string;
  error: OpeningTutorJobError | null;
  createdAt: string;
  updatedAt: string;
  claimToken?: string;
  executionId?: string;
};

function mapJob(row: Record<string, unknown>): OpeningTutorJobRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    conversationId: row.conversation_id as string,
    userTurnId: row.user_turn_id as string,
    assistantTurnId: row.assistant_turn_id as string,
    status: row.status as OpeningTutorJobRecord["status"],
    mode: row.mode as string,
    error: tutorFailureForDisplay(row.status, row.error),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    ...(typeof row.claim_token === "string" ? { claimToken: row.claim_token } : {}),
    ...(typeof row.timing_execution_id === "string" ? { executionId: row.timing_execution_id } : {}),
  };
}

export type OpeningTutorJobsRepository = ReturnType<typeof createOpeningTutorJobsRepository>;

type StreamPublicationContext = {
  privacyEpoch: number; contextSourceRefs: ContextSourceRef[]; claimToken?: string; executionId?: string;
  materialPurposePin?: OpeningMaterialPurposePin;
  memoryLineageSourceIds?: readonly string[];
  globalMemoryIds?: readonly string[];
};

type StreamTurnBinding = {
  attempt_id?: unknown;
  context_anchor?: unknown;
  source_ids?: unknown;
  source_versions?: unknown;
  course_id?: unknown;
};

const PUBLICATION_CLEANUP_DEADLINE_MS = 1_500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function assertStreamMaterialAdmission(
  sql: Sql,
  tx: TransactionSql,
  scope: OpeningScope,
  turn: StreamTurnBinding,
  materialPurposePin: OpeningMaterialPurposePin | undefined,
  contextSourceRefs: readonly ContextSourceRef[] = [],
  verifiedAttemptRefs?: readonly ContextSourceRef[],
  admissionOptions: {
    allowMissingPin?: boolean;
    skipPinRepoAssert?: boolean;
    memoryLineageSourceIds?: readonly string[];
    globalMemoryIds?: readonly string[];
  } = {},
): Promise<void> {
  const anchor = turn.context_anchor as StudyContextAnchor | null | undefined;
  const courseId = (typeof turn.course_id === "string" ? turn.course_id : null)
    ?? (typeof anchor?.courseId === "string" ? anchor.courseId : null);
  const materialUse = turn.attempt_id || anchor?.itemVersionId ? "practice" as const : "citation" as const;
  const turnSourceIds = Array.isArray(turn.source_ids)
    ? [...new Set(turn.source_ids.filter((value): value is string => typeof value === "string"))]
    : [];
  const memoryLineageSet = new Set<string>();
  if (admissionOptions.memoryLineageSourceIds !== undefined) {
    if (!Array.isArray(admissionOptions.memoryLineageSourceIds)) {
      throw Object.assign(new Error("stream memory lineage invalid"), { code: "CONFLICT" });
    }
    for (const sourceId of admissionOptions.memoryLineageSourceIds) {
      if (typeof sourceId !== "string" || !UUID_PATTERN.test(sourceId)) {
        throw Object.assign(new Error("stream memory lineage invalid"), { code: "CONFLICT" });
      }
      memoryLineageSet.add(sourceId.toLowerCase());
    }
  }
  const globalMemoryIdSet = new Set<string>();
  if (admissionOptions.globalMemoryIds !== undefined) {
    if (!Array.isArray(admissionOptions.globalMemoryIds)) {
      throw Object.assign(new Error("stream global memory binding invalid"), { code: "CONFLICT" });
    }
    for (const memoryId of admissionOptions.globalMemoryIds) {
      if (typeof memoryId !== "string" || !UUID_PATTERN.test(memoryId)) {
        throw Object.assign(new Error("stream global memory binding invalid"), { code: "CONFLICT" });
      }
      globalMemoryIdSet.add(memoryId.toLowerCase());
    }
  }
  const globalMemoryIdList = [...globalMemoryIdSet].sort();
  let pin: OpeningMaterialPurposePin | undefined;
  if (materialPurposePin === undefined) {
    if (turnSourceIds.length && !admissionOptions.allowMissingPin) {
      throw Object.assign(new Error("stream material purpose pin missing"), { code: "CONFLICT" });
    }
  } else {
    const parsed = openingMaterialPurposePinSchema.safeParse(materialPurposePin);
    if (!parsed.success) {
      throw Object.assign(new Error("stream material purpose pin invalid"), { code: "CONFLICT" });
    }
    pin = parsed.data;
    if ((pin.courseId?.toLowerCase() ?? null) !== (courseId?.toLowerCase() ?? null)
      || pin.materialUse !== materialUse) {
      throw Object.assign(new Error("stream material purpose pin mismatch"), { code: "CONFLICT" });
    }
    const turnSourceIdSet = new Set(turnSourceIds.map(sourceId => sourceId.toLowerCase()));
    if (pin.sources.some(source => !turnSourceIdSet.has(source.sourceId.toLowerCase()))) {
      throw Object.assign(new Error("stream material purpose pin mismatch"), { code: "CONFLICT" });
    }
    if (turnSourceIds.length) {
      if (!pin.sources.length) {
        throw Object.assign(new Error("stream material purpose pin incomplete"), { code: "CONFLICT" });
      }
      const pinnedIds = new Set(pin.sources.map(source => source.sourceId.toLowerCase()));
      const unpinned = turnSourceIds.filter(sourceId => !pinnedIds.has(sourceId.toLowerCase()));
      if (unpinned.length) {
        const excluded = await tx`SELECT source_id FROM opening_privacy_exclusions
          WHERE workspace_id=${scope.workspaceId} AND source_id=ANY(${unpinned}::uuid[])`;
        const excludedIds = new Set(excluded.map(row => String(row.source_id).toLowerCase()));
        if (unpinned.some(sourceId => !excludedIds.has(sourceId.toLowerCase()))) {
          throw Object.assign(new Error("stream material purpose pin incomplete"), { code: "CONFLICT" });
        }
      }
    }
  }
  const attemptRefSet = new Set((verifiedAttemptRefs ?? []).map(ref => `${ref.sourceId.toLowerCase()}:${ref.sourceVersion}`));
  const verifiedAttemptSourceIds = new Set((verifiedAttemptRefs ?? []).map(ref => ref.sourceId.toLowerCase()));
  const pinnedSourceIds = new Set((pin?.sources ?? []).map(source => source.sourceId.toLowerCase()));
  const explicitSourceIds = new Set([
    ...pinnedSourceIds,
    ...turnSourceIds.map(sourceId => sourceId.toLowerCase()),
    ...(typeof anchor?.sourceId === "string" ? [anchor.sourceId.toLowerCase()] : []),
  ]);
  const derivedSourceIds = [...new Set([
    ...contextSourceRefs
      .filter(ref => !attemptRefSet.has(`${ref.sourceId.toLowerCase()}:${ref.sourceVersion}`))
      .map(ref => ref.sourceId.toLowerCase()),
    ...(typeof anchor?.sourceId === "string" && !verifiedAttemptSourceIds.has(anchor.sourceId.toLowerCase())
      ? [anchor.sourceId.toLowerCase()]
      : []),
  ].filter(sourceId => !pinnedSourceIds.has(sourceId)))].sort();
  const memoryOnlySourceIds = derivedSourceIds.filter(
    sourceId => memoryLineageSet.has(sourceId) && !explicitSourceIds.has(sourceId),
  );
  const memoryOnlySet = new Set(memoryOnlySourceIds);
  const courseDerivedSourceIds = derivedSourceIds.filter(sourceId => !memoryOnlySet.has(sourceId));
  if (derivedSourceIds.length) {
    // Lock courses -> all opening_sources (pinned + derived + memory lineage) in deterministic ID order
    // BEFORE any course_asset_memberships lock so addAssetMembership(FOR UPDATE on opening_sources)
    // can never deadlock or race standalone/mock_exam classification.
    if (courseId !== null) {
      const course = await tx`SELECT id FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId}
        AND archived_at IS NULL FOR SHARE`;
      if (!course.length) throw Object.assign(new Error("course is no longer available"), { code: "CONFLICT" });
    }
    const allSourceIds = [...new Set([...pinnedSourceIds, ...derivedSourceIds])].sort();
    const lockedSources = await tx`SELECT s.id,s.version FROM opening_sources s
      WHERE s.workspace_id=${scope.workspaceId} AND s.id=ANY(${allSourceIds}::uuid[])
      ORDER BY s.id FOR SHARE OF s`;
    if (lockedSources.length !== allSourceIds.length) {
      throw Object.assign(new Error("stream material unavailable or excluded"), { code: "CONFLICT" });
    }
  }
  if (pin && !admissionOptions.skipPinRepoAssert && (pin.courseId !== null || pin.sources.length > 0)) {
    await createOpeningCourseReadySourcesRepository(sql).assertMaterialPurposePin(scope, pin, tx);
  }
  if (globalMemoryIdList.length) {
    // Lock and verify every exact injected global memory is still active (never superseded/deleted).
    const activeMemories = await tx`SELECT id FROM opening_memories
      WHERE workspace_id=${scope.workspaceId}
        AND id=ANY(${globalMemoryIdList}::uuid[])
        AND status='active'
        AND course_id IS NULL
      ORDER BY id FOR SHARE`;
    if (activeMemories.length !== globalMemoryIdList.length) {
      throw Object.assign(new Error("stream global memory is no longer active"), { code: "CONFLICT" });
    }
  }
  if (memoryOnlySourceIds.length) {
    if (!globalMemoryIdList.length) {
      throw Object.assign(new Error("stream global memory binding missing"), { code: "CONFLICT" });
    }
    // Workspace-wide global memory lineage does not require active-course membership,
    // but must still be genuinely backed by the exact active global memories and never mock_exam.
    const backed = await tx`
      SELECT DISTINCT lower(sid.id::text) AS source_id
      FROM unnest(${memoryOnlySourceIds}::uuid[]) AS sid(id)
      WHERE EXISTS (
        SELECT 1
        FROM opening_memories m
        WHERE m.workspace_id = ${scope.workspaceId}
          AND m.id = ANY(${globalMemoryIdList}::uuid[])
          AND m.status = 'active'
          AND m.course_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(m.source_turn_ids) AS ref(turn_id)
            JOIN opening_turns t ON t.id::text = ref.turn_id AND t.workspace_id = ${scope.workspaceId}
            JOIN opening_conversations c ON c.id = t.conversation_id
              AND c.workspace_id = ${scope.workspaceId}
              AND c.owner_user_id = ${scope.ownerUserId}
            WHERE sid.id = ANY(t.source_ids)
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(${turnContextSourceRefs(tx, "t")}) = 'array'
                    THEN ${turnContextSourceRefs(tx, "t")}
                    ELSE '[]'::jsonb
                  END
                ) AS turn_ref
                WHERE lower(turn_ref->>'sourceId') = lower(sid.id::text)
              )
          )
      )`;
    if (backed.length !== memoryOnlySourceIds.length) {
      throw Object.assign(new Error("source purpose no longer permits this use"), { code: "CONFLICT" });
    }
    const mockExam = await tx`SELECT id FROM course_asset_memberships
      WHERE workspace_id=${scope.workspaceId} AND asset_type='source'
        AND asset_id=ANY(${memoryOnlySourceIds}::uuid[]) AND purpose='mock_exam'
      ORDER BY asset_id FOR SHARE`;
    if (mockExam.length) {
      throw Object.assign(new Error("source purpose no longer permits this use"), { code: "CONFLICT" });
    }
  }
  if (!courseDerivedSourceIds.length) return;
  if (courseId === null) {
    const classified = await tx`SELECT id FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId}
      AND asset_type='source' AND asset_id=ANY(${courseDerivedSourceIds}::uuid[]) AND purpose IS NOT NULL FOR SHARE`;
    if (classified.length) {
      throw Object.assign(new Error("select a course to use classified materials"), { code: "CONFLICT" });
    }
    return;
  }
  const memberships = await tx`SELECT asset_id,purpose FROM course_asset_memberships
    WHERE workspace_id=${scope.workspaceId} AND course_id=${courseId}
      AND asset_type='source' AND asset_id=ANY(${courseDerivedSourceIds}::uuid[]) ORDER BY asset_id FOR SHARE`;
  const bySource = new Map(memberships.map(row => [String(row.asset_id).toLowerCase(), row.purpose as CourseSourcePurpose | null]));
  for (const sourceId of courseDerivedSourceIds) {
    if (!bySource.has(sourceId) || !courseSourcePurposeAllows(bySource.get(sourceId) ?? null, materialUse)) {
      throw Object.assign(new Error("source purpose no longer permits this use"), { code: "CONFLICT" });
    }
  }
}

async function assertStreamSources(
  tx: TransactionSql,
  scope: OpeningScope,
  refs: ContextSourceRef[],
  verifiedAttemptRefs?: ContextSourceRef[],
  turnSourceVersions?: Record<string, unknown> | null,
) {
  // The attempt-context read already checks historical availability and privacy for these exact versions.
  const liveRefs = verifiedAttemptRefs?.length
    ? refs.filter(ref => !verifiedAttemptRefs.some(pinned => pinned.sourceId === ref.sourceId && pinned.sourceVersion === ref.sourceVersion))
    : refs;
  const snapshotVersionBySource = new Map<string, number>();
  if (turnSourceVersions && typeof turnSourceVersions === "object") {
    for (const [sourceId, version] of Object.entries(turnSourceVersions)) {
      if (typeof version === "number" && Number.isSafeInteger(version) && version >= 0) {
        snapshotVersionBySource.set(sourceId.toLowerCase(), version);
      }
    }
  }
  const snapshotRefs: ContextSourceRef[] = [];
  const currentRefs: ContextSourceRef[] = [];
  for (const ref of liveRefs) {
    if (snapshotVersionBySource.get(ref.sourceId.toLowerCase()) === ref.sourceVersion) {
      snapshotRefs.push(ref);
    } else {
      currentRefs.push(ref);
    }
  }
  if (snapshotRefs.length) {
    const [snapshotAvailable] = await tx`SELECT 1 WHERE ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`${tx.json(snapshotRefs)}::jsonb`, true, true)}`;
    if (!snapshotAvailable) throw Object.assign(new Error("stream material unavailable or excluded"), { code: "CONFLICT" });
  }
  if (currentRefs.length || !snapshotRefs.length) {
    const [available] = await tx`SELECT 1 WHERE ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`${tx.json(currentRefs)}::jsonb`)}`;
    if (!available) throw Object.assign(new Error("stream material unavailable or excluded"), { code: "CONFLICT" });
  }
}

type UserTurnIntentInput = { userTurnId: string; jobId: string; claimToken?: string };
async function lockIntentUserTurn(tx: TransactionSql, scope: OpeningScope, input: UserTurnIntentInput) {
  await lockWorkspaceLearningHistory(tx, scope);
  const [row] = await tx`SELECT t.*,j.assistant_turn_id FROM opening_tutor_jobs j
    JOIN opening_turns t ON t.id=j.user_turn_id AND t.workspace_id=j.workspace_id AND t.conversation_id=j.conversation_id AND t.role='user'
    JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.workspace_id=j.workspace_id AND a.conversation_id=j.conversation_id AND a.role='assistant'
      AND a.learning_session_id IS NOT DISTINCT FROM t.learning_session_id AND a.attempt_id IS NOT DISTINCT FROM t.attempt_id
    JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
    WHERE j.id=${input.jobId} AND j.user_turn_id=${input.userTurnId} AND j.workspace_id=${scope.workspaceId}
      AND c.owner_user_id=${scope.ownerUserId} AND j.status='running'
      AND j.claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid FOR SHARE OF j FOR UPDATE OF t`;
  if (!row) throw new Error("study intent job lease is no longer current");
  if (row.query_system === true || row.composer_purpose && row.composer_purpose !== "answer" && row.composer_purpose !== "teach"
    || (row.context_anchor as StudyContextAnchor | null)?.purpose === "language_support") {
    throw new Error("read-only or proposal composer purpose cannot change study intent");
  }
  return row;
}

async function applyUserTurnIntentInTx(tx: TransactionSql, scope: OpeningScope, input: UserTurnIntentInput,
  saved?: Record<string, unknown>): Promise<Pick<StudyIntentEvent, "intent" | "action"> | null> {
  const row = saved ?? await lockIntentUserTurn(tx, scope, input);
  const attemptId = row.attempt_id ?? (row.context_anchor as StudyContextAnchor | null)?.attemptId ?? null;
  const [attempt] = attemptId ? await tx`SELECT id,session_id FROM opening_learning_attempts WHERE id=${String(attemptId)}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}` : [];
  const sessionId = attempt?.session_id ?? row.learning_session_id;
  if (!sessionId) return null;
  const [session] = await tx`SELECT id FROM opening_learning_sessions WHERE id=${String(sessionId)}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!session || attemptId && !attempt) throw new Error("study intent target is not owned");
  const latest = await readOpeningStudyIntentInTx(tx, scope, String(sessionId));
  const clientKey = `tutor-intent:${input.userTurnId}`;
  const replay = await tx`SELECT id FROM opening_study_intent_events WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND (client_key=${clientKey} OR client_key LIKE ${`${clientKey}:signal:%`}) LIMIT 1`;
  if (replay.length) return latest;
  const text = composerMessageText(String(row.text)), current = latest?.intent ?? DEFAULT_STUDY_SESSION_INTENT;
  const applied = parseExplicitStudyMessage(current, text);
  if (!applied) return latest;
  const changed = !isDeepStrictEqual(current, applied.intent);
  if (!changed && !applied.signals.length && !applied.needsConfirmation) return latest;
  const target = { sessionId: String(sessionId), ...(attempt ? { attemptId: String(attempt.id) } : {}) };
  if (text.length <= 2000 && (attempt || !applied.signals.some(signal => signal === "guessed" || signal === "copied_answer"))) {
    return appendOpeningStudyIntentInTx(tx, scope, { ...target, clientKey, change: { kind: "explicit_request", text } });
  }
  if (changed) await appendOpeningStudyIntentInTx(tx, scope, { ...target, clientKey, change: { kind: "preference", intent: applied.intent } });
  for (const signal of applied.signals) {
    if (!attempt && (signal === "guessed" || signal === "copied_answer")) continue;
    await appendOpeningStudyIntentInTx(tx, scope, { ...target, clientKey: `${clientKey}:signal:${signal}`, change: { kind: "signal", signal } });
  }
  return studyIntentForMessage(latest, text);
}

type CompletedCandidateTarget = {
  scope: OpeningScope;
  jobId: string;
  assistantTurnId: string;
  expectedPrivacyEpoch?: number;
  claimToken?: string;
  metadataLease?: { id: string; claimToken?: string };
};

/** Optional metadata consumes exactly the saved answer's still-authorized context. */
async function findCompletedCandidateTarget(db: Sql | TransactionSql, input: CompletedCandidateTarget) {
  const [target] = await db`
    SELECT j.conversation_id, j.user_turn_id, j.mode, t.text AS answer, u.text AS question, t.context_source_refs
    FROM opening_tutor_jobs j
    JOIN workspaces w ON w.id=j.workspace_id AND w.owner_user_id=${input.scope.ownerUserId}
    JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
      AND c.owner_user_id=w.owner_user_id
    JOIN opening_turns t ON t.id=j.assistant_turn_id AND t.workspace_id=j.workspace_id
      AND t.conversation_id=j.conversation_id AND t.role='assistant' AND t.status='complete'
    JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=j.workspace_id
      AND u.conversation_id=j.conversation_id AND u.role='user'
    WHERE j.id=${input.jobId} AND j.workspace_id=${input.scope.workspaceId}
      AND j.assistant_turn_id=${input.assistantTurnId} AND j.status='succeeded'
      AND j.claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid
      AND (${input.expectedPrivacyEpoch ?? null}::integer IS NULL OR w.privacy_epoch=${input.expectedPrivacyEpoch ?? null})
      AND ${contextSourceRefsIncluded(db, input.scope.workspaceId, db`t.context_source_refs`)}
      AND (${input.metadataLease === undefined} OR EXISTS (
        SELECT 1 FROM opening_jobs metadata WHERE metadata.id=${input.metadataLease?.id ?? null}::uuid
          AND metadata.workspace_id=j.workspace_id AND metadata.owner_user_id=w.owner_user_id
          AND metadata.kind='tutor-metadata' AND metadata.state='running'
          AND metadata.claim_token IS NOT DISTINCT FROM ${input.metadataLease?.claimToken ?? null}::uuid
          AND metadata.privacy_epoch=w.privacy_epoch AND metadata.payload->>'tutorJobId'=j.id::text
          AND metadata.payload->>'assistantTurnId'=t.id::text
      ))
      AND NOT EXISTS (SELECT 1 FROM opening_assistant_candidates candidate
        WHERE candidate.workspace_id=j.workspace_id AND candidate.source_turn_id=t.id)
  `;
  return target;
}

/**
 * Durable tutor job state machine (0017). Claims are CAS so a BullMQ
 * redelivery rechecks the DB before executing. The answer and job finish
 * atomically; optional suggestions may be appended after that completion.
 */
export type OpeningTutorJobsRepositoryOptions = {
  /**
   * When set, reads (get / findPendingForConversation) end a job that has been
   * queued (never claimed, e.g. its queue message was lost or deduplicated) or
   * running without a heartbeat for this long, so polling clients always reach a
   * terminal status. The worker sweep (expireStale) covers jobs nobody is polling.
   */
  staleMs?: number;
  tutorStreamRedisUrl?: string;
};

export const TUTOR_INTERRUPTED_MESSAGE = "回答任务已中断，执行结果待确认；为避免重复调用未自动重发。";

export function createOpeningTutorJobsRepository(sql: Sql, options: OpeningTutorJobsRepositoryOptions = {}) {
  async function markTerminal(input: {
    scope: OpeningScope;
    jobId: string;
    message: string;
    status: "failed" | "outcome_unknown";
    detail?: { code: string; nextAction?: "clarify" };
    claimToken?: string;
    staleBefore?: Date;
  }): Promise<boolean> {
    const errorJson: OpeningTutorJobError = { message: input.message, ...(input.detail ?? {}) };
    // Only this invocation can request the post-rollback, read-only deletion path.
    const workspaceDeleted = new Error("terminal workspace deleted after history ensure");
    let pendingSeal: { workspaceId: string; jobId: string; executionId: string } | undefined;
    const ended = await sql.begin(async (tx) => {
      // Recovery supplies an empty owner, and this legacy CAS has no owner
      // predicate. Canonical ownership coordinates history only, not authorization.
      const [canonical] = await tx`SELECT owner_user_id FROM workspaces WHERE id=${input.scope.workspaceId}`;
      let historyLocked = false;
      if (canonical) {
        try {
          await lockWorkspaceLearningHistory(tx, { workspaceId: input.scope.workspaceId, ownerUserId: canonical.owner_user_id });
          historyLocked = true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "NOT_FOUND"
            && error.message === "workspace not found")) throw error;
          const remaining = await tx`SELECT id FROM workspaces WHERE id=${input.scope.workspaceId}`;
          if (remaining.length) throw error;
          // Deleted before ensure: retain the original workspace/job queries,
          // including their UUID cast errors, rather than returning early.
        }
      }
      const [workspace] = await tx`
        SELECT id, owner_user_id FROM workspaces
        WHERE id = ${input.scope.workspaceId}
        FOR UPDATE
      `;
      if (historyLocked) {
        if (!workspace) throw workspaceDeleted;
        if (workspace.owner_user_id !== canonical!.owner_user_id) {
          throw new Error("terminal history coordination drift: workspace owner changed");
        }
      }
      const updated = input.status === "failed"
        ? await tx`
            UPDATE opening_tutor_jobs SET status = 'failed', error = ${tx.json(errorJson as never)},
              timing_execution_id = NULL, updated_at = now()
            FROM (
              SELECT id AS prior_id, timing_execution_id AS prior_execution_id
              FROM opening_tutor_jobs
              WHERE id = ${input.jobId} AND workspace_id = ${input.scope.workspaceId}
              FOR UPDATE
            ) prior
            WHERE opening_tutor_jobs.id = prior.prior_id AND opening_tutor_jobs.workspace_id = ${input.scope.workspaceId}
              AND opening_tutor_jobs.status IN ('running', 'queued')
              AND (${input.staleBefore !== undefined} OR opening_tutor_jobs.claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid)
              AND (${input.staleBefore ?? null}::timestamptz IS NULL OR opening_tutor_jobs.updated_at < ${input.staleBefore ?? null}::timestamptz)
            RETURNING opening_tutor_jobs.id, opening_tutor_jobs.workspace_id, opening_tutor_jobs.assistant_turn_id, prior.prior_execution_id AS timing_execution_id
          `
        : await tx`
            UPDATE opening_tutor_jobs SET status = 'outcome_unknown',
              error = ${tx.json({ message: input.message } as never)}, timing_execution_id = NULL, updated_at = now()
            FROM (
              SELECT id AS prior_id, timing_execution_id AS prior_execution_id
              FROM opening_tutor_jobs
              WHERE id = ${input.jobId} AND workspace_id = ${input.scope.workspaceId}
              FOR UPDATE
            ) prior
            WHERE opening_tutor_jobs.id = prior.prior_id AND opening_tutor_jobs.workspace_id = ${input.scope.workspaceId}
              AND opening_tutor_jobs.status = 'running'
              AND (${input.staleBefore !== undefined} OR opening_tutor_jobs.claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid)
              AND (${input.staleBefore ?? null}::timestamptz IS NULL OR opening_tutor_jobs.updated_at < ${input.staleBefore ?? null}::timestamptz)
            RETURNING opening_tutor_jobs.id, opening_tutor_jobs.workspace_id, opening_tutor_jobs.assistant_turn_id, prior.prior_execution_id AS timing_execution_id
          `;
      if (!updated.length) return false;
      const terminalJob = updated[0] as Record<string, unknown>;
      const assistantTurnId = terminalJob.assistant_turn_id as string;
      const executionId = typeof terminalJob.timing_execution_id === "string" ? terminalJob.timing_execution_id : undefined;
      // A terminal turn (complete/failed/clarify/outcome_unknown) is never
      // rewritten, even if a stale job row is swept or re-terminated later.
      const terminal = [...TERMINAL_TURN_STATUSES];
      if (input.status === "failed" && terminalTurnStatusForJobError(input.detail) === "clarify") {
        // LAB-U01: a page-citation refusal is a Clarify follow-up, not a failure.
        await tx`
          UPDATE opening_turns SET text = ${input.message}, status = 'clarify'
          WHERE id = ${assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
            AND NOT (status = ANY(${terminal}::text[]))
        `;
      } else if (input.status === "failed") {
        await tx`
          UPDATE opening_turns SET text = ${input.message}, status = 'failed'
          WHERE id = ${assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
            AND NOT (status = ANY(${terminal}::text[]))
        `;
      } else {
        await tx`
          UPDATE opening_turns SET text = ${input.message}, status = 'outcome_unknown'
          WHERE id = ${assistantTurnId} AND workspace_id = ${input.scope.workspaceId}
            AND NOT (status = ANY(${terminal}::text[]))
        `;
      }
      if (executionId) {
        pendingSeal = { workspaceId: terminalJob.workspace_id as string, jobId: terminalJob.id as string, executionId };
      }
      return true;
    }).catch(async (error: unknown) => {
      if (error !== workspaceDeleted) throw error;
      // History's lazy insert must be rolled back before this no-write result.
      // Keep the legacy missing-workspace job/token UUID errors; never retry CAS
      // against a workspace that might subsequently be recreated.
      await sql`SELECT id FROM opening_tutor_jobs
        WHERE id = ${input.jobId} AND workspace_id = ${input.scope.workspaceId}
          AND claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid`;
      return false;
    });
    if (ended && pendingSeal) {
      // PostgreSQL has already committed terminal status and cleared timing_execution_id,
      // fencing all stream reads and publications. Fire a bounded, unref'd Redis seal
      // post-commit without blocking fail/markUnknown/recoverExpired during a Redis outage.
      void fenceCancelledOpeningTutorStream(
        pendingSeal.workspaceId, pendingSeal.jobId, pendingSeal.executionId, options.tutorStreamRedisUrl,
      ).catch(() => undefined);
    }
    return ended;
  }

  /**
   * End tutor jobs stuck past staleMs. A queued job was never claimed, so no model
   * call happened: it fails with code TUTOR_JOB_STALE and the client can ask again.
   * A running job without heartbeat may have spent money: like recoverExpired it
   * becomes outcome_unknown and is never re-executed. Both writes are CAS-fenced on
   * updated_at, so a job claimed or heart-beaten meanwhile is left alone.
   */
  async function expireStale(input: { staleMs: number; jobId?: string; workspaceId?: string; limit?: number }): Promise<number> {
    const staleSeconds = Math.max(1, Math.floor(input.staleMs / 1000));
    const rows = await sql<{ id: string; workspace_id: string; status: string; stale_before: Date }[]>`
      SELECT id, workspace_id, status, now() - make_interval(secs => ${staleSeconds}) AS stale_before
      FROM opening_tutor_jobs
      WHERE status IN ('queued', 'running')
        AND updated_at < now() - make_interval(secs => ${staleSeconds})
        AND (${input.jobId ?? null}::uuid IS NULL OR id = ${input.jobId ?? null}::uuid)
        AND (${input.workspaceId ?? null}::uuid IS NULL OR workspace_id = ${input.workspaceId ?? null}::uuid)
      ORDER BY updated_at LIMIT ${input.limit ?? 50}`;
    let expired = 0;
    for (const row of rows) {
      const scope = { workspaceId: row.workspace_id, ownerUserId: "" };
      const ended = row.status === "queued"
        ? await markTerminal({ scope, jobId: row.id, message: TUTOR_STALE_MESSAGE, status: "failed",
          detail: { code: "TUTOR_JOB_STALE" }, staleBefore: row.stale_before })
        : await markTerminal({ scope, jobId: row.id, message: TUTOR_INTERRUPTED_MESSAGE, status: "outcome_unknown",
          staleBefore: row.stale_before });
      if (ended) expired += 1;
    }
    return expired;
  }

  async function findPending(scope: OpeningScope, conversationId: string): Promise<{
    id: string;
    status: OpeningTutorJobRecord["status"];
    error: OpeningTutorJobError | null;
    updatedAt: string;
  } | null> {
    const rows = await sql`
      SELECT j.id, j.status, j.error, j.updated_at, t.status AS turn_status
      FROM opening_tutor_jobs j
      JOIN opening_conversations c ON c.id = j.conversation_id
      JOIN opening_turns t ON t.id = j.assistant_turn_id
      WHERE j.conversation_id = ${conversationId}
        AND j.workspace_id = ${scope.workspaceId}
        AND c.workspace_id = ${scope.workspaceId}
        AND c.owner_user_id = ${scope.ownerUserId}
        AND t.workspace_id = ${scope.workspaceId}
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT 1
    `;
    if (!rows.length) return null;
    const row = rows[0] as Record<string, unknown>;
    // Inspect the latest job before filtering statuses so an older unknown
    // result cannot resurface after a newer answer has already ended.
    const active = (row.status === "queued" || row.status === "running") && row.turn_status === "pending";
    const unknown = row.status === "outcome_unknown"
      && (row.turn_status === "pending" || row.turn_status === "outcome_unknown");
    if (!active && !unknown) return null;
    return {
      id: row.id as string,
      status: row.status as OpeningTutorJobRecord["status"],
      error: tutorFailureForDisplay(row.status, row.error),
      updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    };
  }

  async function getJob(scope: OpeningScope, id: string): Promise<OpeningTutorJobRecord | null> {
    const rows = await sql`
      SELECT j.* FROM opening_tutor_jobs j
      JOIN opening_conversations c ON c.id = j.conversation_id
      WHERE j.id = ${id}
        AND j.workspace_id = ${scope.workspaceId}
        AND c.workspace_id = ${scope.workspaceId}
        AND c.owner_user_id = ${scope.ownerUserId}
      LIMIT 1
    `;
    return rows.length ? mapJob(rows[0] as Record<string, unknown>) : null;
  }

  /** Read-time reconciliation for one job a client is looking at. */
  async function expireIfStale(scope: OpeningScope, jobId: string, status: string): Promise<boolean> {
    if (!options.staleMs || (status !== "queued" && status !== "running")) return false;
    return (await expireStale({ staleMs: options.staleMs, jobId, workspaceId: scope.workspaceId, limit: 1 })) > 0;
  }

  return {
    loadHistory: (scope: OpeningScope, currentTurnId: string) => loadTutorHistory(sql, scope, currentTurnId),
    loadHistoryContext: (scope: OpeningScope, currentTurnId: string, purpose?: TutorHistoryPurpose) => loadTutorHistoryContext(sql, scope, currentTurnId, purpose),
    async claim(id: string): Promise<OpeningTutorJobRecord | null> {
      return sql.begin(async tx => {
      // Completion/cancellation lock the workspace before the job. Hold the
      // referenced workspace first so the timing insert cannot invert that order.
      const owner = await tx`SELECT w.id FROM workspaces w JOIN opening_tutor_jobs j ON j.workspace_id=w.id
        WHERE j.id=${id} FOR KEY SHARE OF w`;
      if (!owner.length) return null;
      const executionId = randomUUID();
      const rows = await tx`
        UPDATE opening_tutor_jobs j SET status = 'running', claim_token = ${randomUUID()}, timing_execution_id=${executionId}, updated_at = now()
        FROM workspaces w,opening_conversations c
        WHERE j.id = ${id} AND j.workspace_id = w.id
          AND c.id=j.conversation_id AND c.workspace_id=j.workspace_id AND c.owner_user_id=w.owner_user_id
          AND j.status = 'queued'
        RETURNING j.*, w.owner_user_id, clock_timestamp() AS claimed_at
      `;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      const observedAt = new Date(row.claimed_at as string | Date);
      const [preferences] = await tx`SELECT planning_settings FROM workspace_preferences WHERE workspace_id=${row.workspace_id as string}`;
      const zone = (preferences?.planning_settings as { timeZone?: string } | null)?.timeZone;
      await tx`INSERT INTO opening_learning_experience_events
        (workspace_id,owner_user_id,event_key,kind,target_type,target_id,local_day,execution_id,observed_at,recorded_at)
        VALUES(${row.workspace_id as string},${row.owner_user_id as string},${`tutor_claimed:${id}:${executionId}`},
          'tutor_claimed','job',${id},${localDateKeyInZone(observedAt, resolveWorkspaceTimeZone(zone))},${executionId},${observedAt},clock_timestamp())`;
      return { ...mapJob(row), ownerUserId: row.owner_user_id as string, executionId };
      }) as Promise<OpeningTutorJobRecord | null>;
    },

    async heartbeat(id: string, claimToken: string): Promise<boolean> {
      const rows = await sql`UPDATE opening_tutor_jobs SET updated_at = now()
        WHERE id = ${id} AND status = 'running' AND claim_token = ${claimToken} RETURNING id`;
      return rows.length > 0;
    },

    async recoverExpired(limit = 50): Promise<number> {
      const rows = await sql`SELECT id, workspace_id, now() - interval '5 minutes' AS stale_before FROM opening_tutor_jobs
        WHERE status = 'running' AND updated_at < now() - interval '5 minutes' ORDER BY updated_at LIMIT ${limit}`;
      let recovered = 0;
      for (const row of rows) {
        if (await markTerminal({ scope: { workspaceId: row.workspace_id, ownerUserId: "" }, jobId: row.id,
          message: TUTOR_INTERRUPTED_MESSAGE, status: "outcome_unknown", staleBefore: row.stale_before as Date })) recovered += 1;
      }
      return recovered;
    },

    expireStale,

    async findPendingForConversation(
      scope: OpeningScope,
      conversationId: string,
    ): Promise<{
      id: string;
      status: OpeningTutorJobRecord["status"];
      error: OpeningTutorJobError | null;
      updatedAt: string;
    } | null> {
      const pending = await findPending(scope, conversationId);
      if (pending && await expireIfStale(scope, pending.id, pending.status)) return findPending(scope, conversationId);
      return pending;
    },

    async cancel(scope: OpeningScope, id: string): Promise<OpeningTutorJobRecord | null> {
      const coordinationChanged = new Error("cancel workspace changed after history ensure");
      let priorExecutionId: string | undefined;
      const cancelled = await sql.begin(async (tx) => {
        // Canonical ownership selects the history key only. Cancellation still
        // authorizes against the conversation owner, including after a static workspace move.
        const [canonical] = await tx`SELECT owner_user_id FROM workspaces WHERE id=${scope.workspaceId}`;
        let historyLocked = false;
        if (canonical) {
          try {
            await lockWorkspaceLearningHistory(tx, { workspaceId: scope.workspaceId, ownerUserId: canonical.owner_user_id });
            historyLocked = true;
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "NOT_FOUND"
              && error.message === "workspace not found")) throw error;
            const remaining = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}`;
            if (remaining.length) throw error;
            // Confirmed deletion retains the original queries and UUID errors.
          }
        }
        const [workspace] = await tx`
          SELECT id, owner_user_id FROM workspaces
          WHERE id = ${scope.workspaceId}
          FOR UPDATE
        `;
        // New coordination refusal: roll back lazy history before returning null.
        // Never relock a new owner or retry a write against a recreated workspace.
        if (historyLocked && (!workspace || workspace.owner_user_id !== canonical!.owner_user_id)) throw coordinationChanged;
        const rows = await tx`
          UPDATE opening_tutor_jobs j
          SET status = 'cancelled', timing_execution_id = NULL, updated_at = now(), error = ${tx.json({ message: "cancelled by user" } as never)}
          FROM (
            SELECT id AS prior_id, timing_execution_id AS prior_execution_id
            FROM opening_tutor_jobs
            WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
            FOR UPDATE
          ) prior, opening_conversations c
          WHERE j.id = prior.prior_id
            AND j.workspace_id = ${scope.workspaceId}
            AND c.id = j.conversation_id
            AND c.workspace_id = ${scope.workspaceId}
            AND c.owner_user_id = ${scope.ownerUserId}
            AND j.status IN ('queued', 'running')
          RETURNING j.*, prior.prior_execution_id
        `;
        if (!rows.length) return null;
        await tx`
          UPDATE opening_turns
          SET status = 'failed', text = '回答任务已取消'
          WHERE id = ${rows[0]!.assistant_turn_id}
            AND workspace_id = ${scope.workspaceId}
            AND NOT (status = ANY(${[...TERMINAL_TURN_STATUSES]}::text[]))
        `;
        const row = rows[0] as Record<string, unknown>;
        priorExecutionId = typeof row.prior_execution_id === "string"
          ? row.prior_execution_id
          : typeof row.timing_execution_id === "string" ? row.timing_execution_id : undefined;
        return mapJob(row);
      }).catch(async (error: unknown) => {
        if (error !== coordinationChanged) throw error;
        // Preserve the original CAS's filtering/casts (notably invalid job UUIDs)
        // after rollback, without retrying cancellation or exposing any row.
        await sql`SELECT j.id FROM opening_tutor_jobs j, opening_conversations c
          WHERE j.id = ${id}
            AND j.workspace_id = ${scope.workspaceId}
            AND c.id = j.conversation_id
            AND c.workspace_id = ${scope.workspaceId}
            AND c.owner_user_id = ${scope.ownerUserId}
            AND j.status IN ('queued', 'running')`;
        return null;
      });
      if (cancelled && priorExecutionId) {
        // PostgreSQL already committed status='cancelled' and timing_execution_id=NULL.
        // Fire a bounded, unref'd Redis seal post-commit so Stop returns immediately even during a Redis outage.
        void fenceCancelledOpeningTutorStream(cancelled.workspaceId, cancelled.id, priorExecutionId, options.tutorStreamRedisUrl)
          .catch(() => undefined);
      }
      return cancelled;
    },

    async get(scope: OpeningScope, id: string): Promise<OpeningTutorJobRecord | null> {
      const job = await getJob(scope, id);
      if (job && await expireIfStale(scope, job.id, job.status)) return getJob(scope, id);
      return job;
    },

    /** Hold current job, privacy and attempt authorization through the Redis write. */
    async withStreamPublication(scope: OpeningScope, id: string,
      context: StreamPublicationContext & { attemptContext?: TutorAttemptContext }, publish: () => Promise<void>): Promise<void> {
      let transactionClosed = false;
      let publicationStarted = false;
      let publishPromise: Promise<void> | undefined;
      let unconfirmedSealError: unknown;
      let hasUnconfirmedSealError = false;
      const clearExecutionFence = async (db: Sql | TransactionSql) => {
        await db`UPDATE opening_tutor_jobs
          SET timing_execution_id = NULL
          WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
            AND status = 'running'
            AND claim_token IS NOT DISTINCT FROM ${context.claimToken ?? null}::uuid
            AND timing_execution_id IS NOT DISTINCT FROM ${context.executionId ?? null}::uuid`;
      };
      try {
        await sql.begin(async tx => {
          // Attempt revisions take the history lock before workspace and observation locks.
          if (context.attemptContext) await lockWorkspaceLearningHistory(tx, scope);
          const [workspace] = await tx`SELECT privacy_epoch FROM workspaces
            WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
          if (!workspace || Number(workspace.privacy_epoch) !== context.privacyEpoch) {
            throw Object.assign(new Error("stream authorization changed"), { code: "PRIVACY_EPOCH_MISMATCH" });
          }
          const [job] = await tx`SELECT j.user_turn_id,t.attempt_id,t.context_anchor,t.source_ids,t.source_versions,c.course_id FROM opening_tutor_jobs j
            JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
            JOIN opening_turns t ON t.id=j.user_turn_id AND t.workspace_id=j.workspace_id AND t.conversation_id=j.conversation_id
            WHERE j.id=${id} AND j.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
              AND j.status='running' AND j.claim_token IS NOT DISTINCT FROM ${context.claimToken ?? null}::uuid
              AND j.timing_execution_id IS NOT DISTINCT FROM ${context.executionId ?? null}::uuid
              AND (j.claim_token IS NULL OR j.timing_execution_id IS NOT NULL) FOR SHARE OF j`;
          if (!job) throw Object.assign(new Error("tutor stream execution is no longer current"), { code: "CONFLICT" });
          if (job.attempt_id || (job.context_anchor as StudyContextAnchor | null)?.attemptId || context.attemptContext) {
            if (!context.attemptContext) throw Object.assign(new Error("stream attempt context missing"), { code: "CONFLICT" });
            await assertTutorAttemptContext(tx, scope,
              { jobId: id, userTurnId: String(job.user_turn_id), claimToken: context.claimToken }, context.attemptContext);
          }
          await assertStreamMaterialAdmission(sql, tx, scope, job, context.materialPurposePin,
            context.contextSourceRefs, context.attemptContext?.sourceRefs, {
              memoryLineageSourceIds: context.memoryLineageSourceIds,
              globalMemoryIds: context.globalMemoryIds,
            });
          if (context.contextSourceRefs.length) {
            await assertStreamSources(
              tx, scope, context.contextSourceRefs, context.attemptContext?.sourceRefs,
              job.source_versions as Record<string, unknown> | null | undefined,
            );
          }
          try {
            publicationStarted = true;
            publishPromise = Promise.resolve().then(() => publish());
            void publishPromise.catch(() => undefined);
            await publishPromise;
          } catch (error) {
            if (!transactionClosed && isUnconfirmedStreamSealError(error)) {
              // Fail closed in PostgreSQL before releasing locks so unsealed Redis
              // bytes carrying the old executionId can never pass readStream.
              unconfirmedSealError = error;
              hasUnconfirmedSealError = true;
              await clearExecutionFence(tx);
              return;
            }
            throw error;
          } finally {
            // postgres.js can reject begin() when the connection dies while this
            // callback is awaiting Redis. The server has already rolled back.
            // Keep the abandoned callback from finalizing on the closed socket.
            if (transactionClosed) await new Promise<never>(() => undefined);
          }
        });
      } catch (error: unknown) {
        transactionClosed = true;
        if (publicationStarted) {
          const sealRedisUrl = options.tutorStreamRedisUrl ?? process.env.REDIS_URL?.trim();
          const shouldAttemptRedisSeal = Boolean(context.executionId && !hasUnconfirmedSealError && sealRedisUrl);
          // Share a single <= 1,500 ms deadline across pending publish drain, PG execution fencing,
          // and best-effort Redis fallback sealing so callers never double-wait on a Redis outage.
          const cleanupTasks: Array<Promise<unknown>> = [];
          if (publishPromise) cleanupTasks.push(Promise.allSettled([publishPromise]));
          cleanupTasks.push(Promise.resolve().then(() => clearExecutionFence(sql)).catch(() => undefined));
          if (shouldAttemptRedisSeal) {
            markFallbackStreamSealAttempted(error);
            cleanupTasks.push(
              fenceCancelledOpeningTutorStream(
                scope.workspaceId, id, context.executionId!, sealRedisUrl, PUBLICATION_CLEANUP_DEADLINE_MS,
              ).catch(() => undefined),
            );
          }
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const deadline = new Promise<void>(resolve => {
              cleanupTimer = setTimeout(resolve, PUBLICATION_CLEANUP_DEADLINE_MS);
              cleanupTimer.unref?.();
            });
            await Promise.race([Promise.allSettled(cleanupTasks), deadline]);
          } finally {
            clearTimeout(cleanupTimer);
          }
        }
        if (hasUnconfirmedSealError) throw unconfirmedSealError;
        throw error;
      }
      if (hasUnconfirmedSealError) throw unconfirmedSealError;
    },

    /**
     * Authorize every nonempty stream delivery and record help before bytes leave HTTP.
     * Phase 1 durably commits exposure release before any bytes are enqueued;
     * Phase 2 holds pure read-only FOR SHARE locks synchronously across commitAuthorized.
     */
    async readStream(scope: OpeningScope, id: string, context: StreamPublicationContext & {
      exposureReceiptId: string | null;
      attemptFence?: TutorAttemptFence;
    }, commitAuthorized?: (job: OpeningTutorJobRecord) => void, canDeliver?: () => boolean): Promise<OpeningTutorJobRecord | null> {
      const verifyInTx = async (tx: TransactionSql, lockMode: "FOR UPDATE" | "FOR SHARE"): Promise<OpeningTutorJobRecord | null> => {
        if (lockMode === "FOR UPDATE") await lockWorkspaceLearningHistory(tx, scope);
        const [workspace] = lockMode === "FOR UPDATE"
          ? await tx`SELECT privacy_epoch FROM workspaces
              WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`
          : await tx`SELECT privacy_epoch FROM workspaces
              WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        if (!workspace) return null;
        const [row] = lockMode === "FOR UPDATE"
          ? await tx`SELECT j.*,t.attempt_id,t.context_anchor,t.source_ids,t.source_versions,c.course_id FROM opening_tutor_jobs j
              JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
              JOIN opening_turns t ON t.id=j.user_turn_id AND t.workspace_id=j.workspace_id AND t.conversation_id=j.conversation_id
              WHERE j.id=${id} AND j.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} FOR UPDATE OF j`
          : await tx`SELECT j.*,t.attempt_id,t.context_anchor,t.source_ids,t.source_versions,c.course_id FROM opening_tutor_jobs j
              JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
              JOIN opening_turns t ON t.id=j.user_turn_id AND t.workspace_id=j.workspace_id AND t.conversation_id=j.conversation_id
              WHERE j.id=${id} AND j.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} FOR SHARE OF j`;
        if (!row) return null;
        const job = mapJob(row as Record<string, unknown>);
        if (job.status !== "running") return job;
        if (Number(workspace.privacy_epoch) !== context.privacyEpoch || row.claim_token !== (context.claimToken ?? null)) {
          throw new Error("stream authorization changed");
        }
        if ((row.timing_execution_id === null && row.claim_token !== null)
          || (context.executionId !== undefined && row.timing_execution_id !== context.executionId)) {
          throw new Error("stream execution changed");
        }
        const boundAttempt = row.attempt_id ?? (row.context_anchor as StudyContextAnchor | null)?.attemptId;
        let verifiedAttemptRefs: ContextSourceRef[] | undefined;
        if (boundAttempt || context.attemptFence) {
          const fence = tutorAttemptFenceSchema.safeParse(context.attemptFence);
          if (!fence.success || !boundAttempt) throw new Error("stream attempt fence missing");
          const current = await readTutorAttemptContext(tx, scope, { jobId: id, userTurnId: String(row.user_turn_id), claimToken: context.claimToken });
          if (!current || !isDeepStrictEqual(tutorAttemptFence(current), fence.data)) throw new Error("stream attempt context changed");
          verifiedAttemptRefs = current.sourceRefs;
        }
        await assertStreamMaterialAdmission(sql, tx, scope, row, context.materialPurposePin,
          context.contextSourceRefs, verifiedAttemptRefs, {
            memoryLineageSourceIds: context.memoryLineageSourceIds,
            globalMemoryIds: context.globalMemoryIds,
          });
        await assertStreamSources(
          tx, scope, context.contextSourceRefs, verifiedAttemptRefs,
          row.source_versions as Record<string, unknown> | null | undefined,
        );
        return job;
      };

      // Phase 1: Durable exposure commit (only when an exposure receipt exists, or for
      // direct 3-arg callers that do not pass commitAuthorized).
      let phase1ExecutionId: string | undefined;
      if (context.exposureReceiptId || !commitAuthorized) {
        const phase1Job = await sql.begin(async tx => {
          const job = await verifyInTx(tx, "FOR UPDATE");
          if (!job || job.status !== "running") return job;
          if (context.exposureReceiptId) {
            const [exposure] = await tx`SELECT id FROM opening_help_exposures WHERE id=${context.exposureReceiptId}
              AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
              AND turn_id=${job.assistantTurnId} AND exposure_origin='assistant'`;
            if (!exposure) throw new Error("stream exposure does not belong to assistant turn");
            if (canDeliver && !canDeliver()) throw new Error("stream closed before delivery");
            await releaseOpeningStudyExposure(tx, scope, context.exposureReceiptId);
          }
          return job;
        }) as OpeningTutorJobRecord | null;
        if (!commitAuthorized || !phase1Job || phase1Job.status !== "running") return phase1Job;
        phase1ExecutionId = phase1Job.executionId;
      }

      // Phase 2: Pure read-only FOR SHARE transaction holding row locks synchronously
      // across commitAuthorized (controller.enqueue) with zero DB writes.
      return sql.begin(async tx => {
        const job = await verifyInTx(tx, "FOR SHARE");
        if (!job || job.status !== "running") return job;
        if (phase1ExecutionId !== undefined && job.executionId !== phase1ExecutionId) {
          throw new Error("stream execution changed");
        }
        commitAuthorized(job);
        return job;
      }) as Promise<OpeningTutorJobRecord | null>;
    },

    async listQueued(limit: number): Promise<OpeningTutorJobRecord[]> {
      // Short dispatch lease bounds Redis traffic and is recovered after a crash.
      const rows = await sql`
        UPDATE opening_tutor_jobs j SET dispatch_after = now() + interval '1 minute'
        FROM (SELECT id FROM opening_tutor_jobs WHERE status = 'queued' AND dispatch_after <= now()
          ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT ${limit}) due
        WHERE j.id = due.id RETURNING j.*
      `;
      return rows.map((row) => mapJob(row as Record<string, unknown>));
    },

    /** One statement-consistent read of the bound attempt, with no grading side effects. */
    readAttemptContext: (scope: OpeningScope, target: TutorAttemptContextTarget) =>
      sql.begin("isolation level repeatable read", tx => readTutorAttemptContext(tx, scope, target)) as Promise<TutorAttemptContext | null>,

    assertAttemptContext: (scope: OpeningScope, target: TutorAttemptContextTarget, expected: TutorAttemptContext) =>
      sql.begin("isolation level repeatable read", tx => assertTutorAttemptContext(tx, scope, target, expected)) as Promise<void>,

    /** Complete the answer, lineage and inert help receipt in one transaction. */
    async completeTurn(input: {
      scope: OpeningScope;
      jobId: string;
      assistantTurnId: string;
      text: string;
      citations: Citation[];
      candidates: Array<{ payload: unknown; sourceIds: string[] }>;
      contextSourceRefs?: ContextSourceRef[];
      systemQuery?: SystemQueryReceipt;
      generatedExposure?: OpeningStudyExposureInput;
      helpExposure?: {
        contextAnchor?: StudyContextAnchor;
        supportDomain?: "language" | "math" | "unknown";
        id: string;
        sessionId: string;
        problemId: string | null;
        attemptId?: string | null;
        activityId?: string | null;
        itemVersionId?: string | null;
        turnId: string;
        kind: "instruction" | "hint" | "solution";
        level: "hinted" | "revealed";
        hintStage?: number | null;
        initiatedBy?: "user" | "assistant" | null;
        helpInputSnapshot?: HelpInputSnapshot | null;
        delivered: true;
      };
      expectedPrivacyEpoch?: number;
      claimToken?: string;
      enqueueMetadata?: boolean;
    }, options?: {
      materialPurposePin?: OpeningMaterialPurposePin;
      memoryLineageSourceIds?: readonly string[];
      globalMemoryIds?: readonly string[];
      attemptContext?: { target: TutorAttemptContextTarget; snapshot: TutorAttemptContext };
    }): Promise<void> {
      await sql.begin(async (tx) => {
        if (input.helpExposure || input.generatedExposure) {
          await lockWorkspaceLearningHistory(tx, input.scope);
        } else {
          // Preserve completion's permission error before history's lazy ensure,
          // without taking a business-row lock ahead of the history fence.
          const owner = await tx`SELECT id FROM workspaces
            WHERE id=${input.scope.workspaceId} AND owner_user_id=${input.scope.ownerUserId}`;
          if (!owner.length) throw new Error("workspace permission changed");
          try {
            await lockWorkspaceLearningHistory(tx, input.scope);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "NOT_FOUND"
              && error.message === "workspace not found") throw new Error("workspace permission changed");
            throw error;
          }
        }
        const workspace = await tx`
          SELECT privacy_epoch FROM workspaces WHERE id = ${input.scope.workspaceId} AND owner_user_id=${input.scope.ownerUserId} FOR UPDATE
        `;
        if (!workspace.length) throw new Error("workspace permission changed");
        if (options?.materialPurposePin) {
          await createOpeningCourseReadySourcesRepository(sql).assertMaterialPurposePin(input.scope, options.materialPurposePin, tx);
        }
        if (options?.attemptContext) {
          if (options.attemptContext.target.jobId !== input.jobId) throw new Error("attempt context job mismatch");
          await assertTutorAttemptContext(tx, input.scope, options.attemptContext.target, options.attemptContext.snapshot);
        }
        const receipt = input.systemQuery ? systemQueryReceiptSchema.parse(input.systemQuery) : null;
        if (receipt) {
          if (receipt.authorization.purpose !== "system_record_lookup" || receipt.authorization.workspaceId !== input.scope.workspaceId
            || receipt.authorization.principalId !== input.scope.ownerUserId || receipt.privacyEpoch !== Number(workspace[0]!.privacy_epoch)) throw new Error("query receipt grant changed");
          const refs = mergeContextSourceRefs(...receipt.results.map(result => result.sourceRefs));
          const provided = input.contextSourceRefs ?? [];
          if (refs.some(ref => !provided.some(item => item.sourceId === ref.sourceId && item.sourceVersion === ref.sourceVersion))) throw new Error("query lineage incomplete");
          const [admitted] = await tx`SELECT ${contextSourceRefsIncluded(tx, input.scope.workspaceId, tx`${tx.json(provided)}::jsonb`, true, true)} AS included`;
          if (!admitted?.included) throw new Error("query source unavailable before persistence");
        }
        if (input.expectedPrivacyEpoch !== undefined) {
          const currentEpoch = Number((workspace[0] as { privacy_epoch?: number } | undefined)?.privacy_epoch);
          if (currentEpoch !== input.expectedPrivacyEpoch) {
            throw new Error(
              `privacy epoch drift: expected ${input.expectedPrivacyEpoch} current ${currentEpoch}`,
            );
          }
        }
        if (!receipt && (options?.materialPurposePin !== undefined || input.contextSourceRefs !== undefined || options?.globalMemoryIds !== undefined)) {
          const [boundTurn] = await tx`SELECT t.attempt_id,t.context_anchor,t.source_ids,t.source_versions,c.course_id FROM opening_tutor_jobs j
            JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
            JOIN opening_turns t ON t.id=j.user_turn_id AND t.workspace_id=j.workspace_id AND t.conversation_id=j.conversation_id
            WHERE j.id=${input.jobId} AND j.workspace_id=${input.scope.workspaceId} AND c.owner_user_id=${input.scope.ownerUserId}
              AND j.status='running' AND j.claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid FOR UPDATE OF j`;
          if (boundTurn) {
            await assertStreamMaterialAdmission(
              sql, tx, input.scope, boundTurn, options?.materialPurposePin,
              input.contextSourceRefs ?? [], options?.attemptContext?.snapshot.sourceRefs,
              {
                allowMissingPin: options?.materialPurposePin === undefined,
                skipPinRepoAssert: options?.materialPurposePin !== undefined,
                memoryLineageSourceIds: options?.memoryLineageSourceIds,
                globalMemoryIds: options?.globalMemoryIds,
              },
            );
            if (input.contextSourceRefs?.length) {
              await assertStreamSources(
                tx, input.scope, input.contextSourceRefs,
                options?.attemptContext?.snapshot.sourceRefs,
                boundTurn.source_versions as Record<string, unknown> | null | undefined,
              );
            }
          }
        }
        const claimed = await tx`
          UPDATE opening_tutor_jobs SET status = 'succeeded', timing_execution_id = NULL, error = NULL, updated_at = now()
          WHERE id = ${input.jobId}
            AND workspace_id = ${input.scope.workspaceId}
            AND status = 'running'
            AND claim_token IS NOT DISTINCT FROM ${input.claimToken ?? null}::uuid
          RETURNING id
        `;
        if (!claimed.length) return;
        const assistant = await tx`
          UPDATE opening_turns SET text = ${input.text}, citations = ${tx.json(input.citations as never)},
            system_query=${receipt ? tx.json(receipt as never) : null},
            context_source_refs = ${input.contextSourceRefs === undefined ? null : tx.json(input.contextSourceRefs as never)}, status = 'complete'
          WHERE id = ${input.assistantTurnId} AND workspace_id = ${input.scope.workspaceId} AND (${receipt === null} OR query_system)
          RETURNING id
        `;
        if (!assistant.length) throw new Error("assistant turn was not persisted");
        for (const candidate of input.candidates) {
          await tx`
            INSERT INTO opening_assistant_candidates (
              id, workspace_id, conversation_id, source_turn_id, source_ids, payload
            ) VALUES (
              ${randomUUID()}, ${input.scope.workspaceId},
              (SELECT conversation_id FROM opening_tutor_jobs WHERE id = ${input.jobId}),
              ${input.assistantTurnId},
              ${tx.json(candidate.sourceIds as never)}, ${tx.json(candidate.payload as never)}
            )
          `;
        }
        if (input.helpExposure) await insertOpeningDeliveredHelp(tx, input.scope, input.helpExposure, { generatedOnly: true });
        if (input.generatedExposure) await generateOpeningStudyExposure(tx, input.scope, input.generatedExposure);
        if (input.enqueueMetadata) {
          const jobId = randomUUID();
          const payload = { tutorJobId: input.jobId, assistantTurnId: input.assistantTurnId, tutorClaimToken: input.claimToken ?? null };
          const queued = await tx`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
            VALUES (${jobId}, ${input.scope.workspaceId}, ${input.scope.ownerUserId}, ${`tutor-metadata:${input.jobId}`},
              'tutor-metadata', ${tx.json(payload)}, ${Number(workspace[0]!.privacy_epoch)})
            ON CONFLICT (workspace_id, key) DO NOTHING RETURNING id`;
          if (queued.length) await tx`INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
            VALUES (${input.scope.workspaceId}, ${jobId}, 'opening.job.enqueue', ${tx.json({ jobId, kind: "tutor-metadata" })})`;
        }
      });
    },

    async loadCompletedTurnForMetadata(input: CompletedCandidateTarget): Promise<{
      question: string; answer: string; mode: string; userTurnId: string;
    } | null> {
      const target = await findCompletedCandidateTarget(sql, input);
      return target ? { question: String(target.question), answer: String(target.answer),
        mode: String(target.mode), userTurnId: String(target.user_turn_id) } : null;
    },

    async canAppendCompletedTurnCandidates(input: CompletedCandidateTarget): Promise<boolean> {
      return Boolean(await findCompletedCandidateTarget(sql, input));
    },

    /** Late suggestions never reopen a completed answer or change its text, usage, or exposure. */
    async appendCompletedTurnCandidates(input: CompletedCandidateTarget & { candidates: unknown[] }): Promise<boolean> {
      return sql.begin(async tx => {
        // Serialize against privacy/deletion and another metadata write for this answer.
        await tx`SELECT id FROM workspaces WHERE id=${input.scope.workspaceId}
          AND owner_user_id=${input.scope.ownerUserId} FOR UPDATE`;
        const target = await findCompletedCandidateTarget(tx, input);
        if (!target) return false;
        const sourceIds = [...new Set((target.context_source_refs as ContextSourceRef[]).map(ref => ref.sourceId))];
        for (const payload of input.candidates) {
          await tx`INSERT INTO opening_assistant_candidates
            (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
            VALUES (${randomUUID()}, ${input.scope.workspaceId}, ${target.conversation_id}, ${input.assistantTurnId},
              ${tx.json(sourceIds)}, ${tx.json(payload as never)})`;
        }
        return true;
      });
    },

    /** Legacy API deliberately returns latest on replay, not the model's frozen inputs. */
    async applyUserTurnIntent(scope: OpeningScope, input: UserTurnIntentInput): Promise<Pick<StudyIntentEvent, "intent" | "action"> | null> {
      return sql.begin(tx => applyUserTurnIntentInTx(tx, scope, input));
    },

    /** Freeze before external calls; first intent application and snapshot commit are atomic. */
    async freezeHelpInputSnapshot(scope: OpeningScope, input: UserTurnIntentInput): Promise<HelpInputSnapshot> {
      return sql.begin(async tx => {
        const row = await lockIntentUserTurn(tx, scope, input);
        if (row.help_input_snapshot != null) {
          const frozen = helpInputSnapshotSchema.parse(row.help_input_snapshot);
          if (frozen.userTurnId !== input.userTurnId || frozen.assistantTurnId !== row.assistant_turn_id) throw new Error("help input snapshot job pair mismatch");
          return frozen;
        }
        const applied = await applyUserTurnIntentInTx(tx, scope, input, row);
        const snapshot = helpInputSnapshotSchema.parse({ userTurnId: input.userTurnId, assistantTurnId: row.assistant_turn_id, tutorMode: row.mode,
          studyIntent: applied ? { intent: applied.intent, action: applied.action } : null });
        await tx`UPDATE opening_turns SET help_input_snapshot=${tx.json(snapshot)} WHERE id=${input.userTurnId} AND workspace_id=${scope.workspaceId}`;
        return snapshot;
      });
    },

    async getUserTurn(id: string, workspaceId: string, jobId?: string): Promise<{
      text: string;
      mode: string;
      sourceIds: string[];
      sourceVersions: Record<string, number>;
      currentPage: number | null;
      chunkId: string | null;
      learningSessionId: string | null;
      attemptId?: string | null;
      strategyTemplateId: string | null;
      querySystem?: boolean;
      courseId?: string | null;
      contextAnchor?: StudyContextAnchor;
      purpose?: ComposerPurpose;
      languageSupportQuestion?: string | null;
      studyIntent?: StudyIntentEvent | null;
    } | null> {
      const rows = await sql`
        SELECT t.text,t.mode,t.source_ids,t.source_versions,t.current_page,t.chunk_id,t.learning_session_id,t.attempt_id,t.strategy_template_id,t.query_system,t.context_anchor,t.composer_purpose,c.course_id,c.owner_user_id,v.evaluation_spec,
          COALESCE(t.learning_session_id,(SELECT a.session_id FROM opening_learning_attempts a WHERE a.workspace_id=t.workspace_id AND a.owner_user_id=c.owner_user_id
            AND (a.id=t.attempt_id OR a.id::text=t.context_anchor->>'attemptId') LIMIT 1)) AS intent_session_id
        FROM opening_turns t JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
        LEFT JOIN opening_learning_item_versions v ON v.workspace_id=t.workspace_id AND v.owner_user_id=c.owner_user_id
          AND v.id::text=COALESCE(t.context_anchor->>'itemVersionId',(SELECT a.item_version_id::text FROM opening_learning_attempts a WHERE a.id=t.attempt_id AND a.workspace_id=t.workspace_id AND a.owner_user_id=c.owner_user_id))
        WHERE t.id = ${id} AND t.workspace_id = ${workspaceId} AND t.role='user'
          AND (${jobId == null} OR EXISTS (SELECT 1 FROM opening_tutor_jobs j
            WHERE j.id=${jobId ?? null} AND j.workspace_id=t.workspace_id
              AND j.conversation_id=t.conversation_id AND j.user_turn_id=t.id)) LIMIT 1
      `;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      const studyIntent = row.intent_session_id && row.owner_user_id ? await createOpeningStudyIntentRepository(sql).latest(
        { workspaceId, ownerUserId: String(row.owner_user_id) }, String(row.intent_session_id)) : null;
      return {
        studyIntent,
        text: row.text as string,
        mode: row.mode as string,
        sourceIds: (row.source_ids as string[]) ?? [],
        sourceVersions: (row.source_versions as Record<string, number>) ?? {},
        currentPage: (row.current_page as number | null) ?? null,
        chunkId: (row.chunk_id as string | null) ?? null,
        learningSessionId: (row.learning_session_id as string | null) ?? null,
        attemptId: (row.attempt_id as string | null) ?? null,
        ...(row.context_anchor ? { contextAnchor: row.context_anchor as StudyContextAnchor } : {}),
        ...(row.composer_purpose ? { purpose: row.composer_purpose as ComposerPurpose } : {}),
        languageSupportQuestion: openingCanonicalLanguageQuestion(row.evaluation_spec),
        strategyTemplateId: (row.strategy_template_id as string | null) ?? null,
        querySystem: row.query_system === true, courseId: (row.course_id as string | null) ?? null,
      };
    },

    /**
     * PR-D replay: resolve a budget ledger resultRef ("opening_turn:<id>") to the
     * persisted assistant turn, scope-bound. Null when absent or foreign.
     */
    async loadReplayedTurn(scope: OpeningScope, resultRef: string): Promise<{
      id: string;
      status: string;
      text: string;
    } | null> {
      const match = /^opening_turn:([0-9a-f-]{36})$/i.exec(resultRef);
      if (!match) return null;
      const rows = await sql`
        SELECT t.id, t.status, t.text FROM opening_turns t
        JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.id = ${match[1]!} AND t.workspace_id = ${scope.workspaceId}
          AND w.owner_user_id = ${scope.ownerUserId}
        LIMIT 1
      `;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      return { id: row.id as string, status: row.status as string, text: (row.text as string | null) ?? "" };
    },

    /**
     * PR-D replay: the provider result is already persisted on the complete
     * assistant turn; finish the running job without re-writing the turn.
     * Returns false when the job is no longer running or the turn is not complete.
     */
    async completeFromReplay(scope: OpeningScope, jobId: string, assistantTurnId: string, claimToken?: string): Promise<boolean> {
      const rows = await sql`
        UPDATE opening_tutor_jobs j SET status = 'succeeded', timing_execution_id = NULL, error = NULL, updated_at = now()
        WHERE j.id = ${jobId} AND j.workspace_id = ${scope.workspaceId}
          AND j.assistant_turn_id = ${assistantTurnId}
          AND j.status = 'running'
          AND j.claim_token IS NOT DISTINCT FROM ${claimToken ?? null}::uuid
          AND EXISTS (
            SELECT 1 FROM opening_turns t
            WHERE t.id = ${assistantTurnId} AND t.workspace_id = ${scope.workspaceId} AND t.status = 'complete'
          )
        RETURNING j.id
      `;
      return rows.length === 1;
    },

    async fail(
      scope: OpeningScope,
      jobId: string,
      message: string,
      detail?: { code: string; nextAction?: "clarify" },
      claimToken?: string,
    ): Promise<void> {
      await markTerminal({ scope, jobId, message, status: "failed", detail, claimToken });
    },

    async markUnknown(scope: OpeningScope, jobId: string, message: string, claimToken?: string): Promise<void> {
      await markTerminal({ scope, jobId, message, status: "outcome_unknown", claimToken });
    },
  };
}
