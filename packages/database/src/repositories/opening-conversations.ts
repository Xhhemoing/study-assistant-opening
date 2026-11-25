import { mapOpeningStudyExposure, releaseOpeningStudyExposure } from "./opening-study-exposure";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { resolveOpeningStudyContext } from "./opening-study-context";
import { createHash, randomUUID } from "node:crypto";
import { readOpeningSavedTurnRetry, savedTurnRetryAssistantId, savedTurnRetryMatches } from "./opening-conversation-retry";
export { readOpeningSavedTurnRetry, savedTurnRetryAssistantId } from "./opening-conversation-retry";
import type { Sql, TransactionSql } from "postgres";
import { turnUsesDeletedSource } from "./opening-source-actions-privacy";
import {
  conversationMisconceptionLineage, conversationTurnHasMisconceptionMemories, conversationTurnInactiveMisconception,
  readTurnsWithInvalidMisconceptionMemories, turnHasMisconceptionMemoryDependencies, turnUsesInactiveMisconception,
} from "./v3-bitemporal-misconception-memory";
import { systemQueryReceiptSchema } from "@aistudy/contracts";
import { tutorFailureForDisplay, TUTOR_FAILURE_MESSAGE, TUTOR_UNKNOWN_MESSAGE, TUTOR_CANCELLED_MESSAGE, PAGE_CITATION_CLARIFY_MESSAGE } from "@aistudy/domain";
import type {
  Citation,
  ConversationCreateInput,
  ConversationSummary,
  TurnRecord,
  TutorMode,
  StudyContextAnchor,
  ComposerPurpose,
  StudyExposureReceipt,
} from "@aistudy/contracts";

export type OpeningConversationScope = {
  workspaceId: string;
  ownerUserId: string;
};

export type OpeningConversationErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "VALIDATION";

export class OpeningConversationError extends Error {
  readonly code: OpeningConversationErrorCode;
  constructor(code: OpeningConversationErrorCode, message: string) {
    super(message);
    this.name = "OpeningConversationError";
    this.code = code;
  }
}


/**
 * Contract `conversationSummarySchema.lastTurnPreview` max is 280 **JS code units**
 * (`String.length` / Zod). Postgres `LEFT(text, 280)` counts characters, so emoji /
 * surrogate pairs can still exceed Zod after SQL clip — always re-slice here.
 */
export const LAST_TURN_PREVIEW_MAX = 280;
const INACTIVE_MISCONCEPTION_MESSAGE = "关联学习记录已更新或撤回，此回答内容不再显示。";

export function clipLastTurnPreview(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value.length <= LAST_TURN_PREVIEW_MAX) return value;
  return value.slice(0, LAST_TURN_PREVIEW_MAX);
}


type SavedTurnIntent = {
  querySystem?: true;
  contextAnchor?: StudyContextAnchor;
  purpose?: ComposerPurpose;
  conversationId: string;
  text: string;
  mode: TutorMode;
  privacy: "saved";
  sourceIds: string[];
  sourceVersions: Record<string, number>;
  currentPage: number | null;
  chunkId: string | null;
  learningSessionId: string | null;
  attemptId?: string | null;
  strategyTemplateId?: string | null;
  examRequest?: { purpose?: ComposerPurpose; querySystem?: boolean };
};

type ExamHelpReplay = {
  requested: NonNullable<SavedTurnIntent["examRequest"]>;
  legacyPurpose?: ComposerPurpose;
  legacyQuery?: Pick<SavedTurnIntent, "text" | "mode" | "sourceIds" | "purpose" | "currentPage">;
  replayOnly?: boolean;
};

function hashSavedTurnIntent(intent: SavedTurnIntent): string {
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

export type StoredTurn = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  mode: TutorMode;
  status: "pending" | "complete" | "failed" | "clarify" | "outcome_unknown";
  clientKey: string | null;
  learningSessionId: string | null;
  attemptId?: string | null;
  currentPage: number | null;
  chunkId: string | null;
  sourceIds: string[];
  createdAt: string;
};

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

/** A legacy/imported receipt is untrusted JSON; never display its text after provenance rejection. */
function queryDisplay(row: Record<string, unknown>, scope: OpeningConversationScope) {
  const terminalPendingJob = row.status === "pending" && ["failed", "cancelled", "outcome_unknown"].includes(String(row.job_status));
  const failureStatus = row.role === "assistant" && (["failed", "clarify", "outcome_unknown"].includes(String(row.status)) || terminalPendingJob)
    ? terminalPendingJob ? row.job_status : row.status === "failed" && row.job_status === "cancelled" ? "cancelled" : row.status : null;
  const failure = tutorFailureForDisplay(failureStatus, row.job_error);
  const parsed = row.system_query == null ? null : systemQueryReceiptSchema.safeParse(row.system_query);
  const invalid = parsed !== null && (!parsed.success || parsed.data.authorization.purpose !== "system_record_lookup"
    || parsed.data.authorization.workspaceId !== scope.workspaceId || parsed.data.authorization.principalId !== scope.ownerUserId);
  return { text: failure?.message ?? (invalid ? "此查询回执的来源或权限无法核实，内容不再显示；请重新查询。" : row.text as string),
    citations: failure || invalid ? [] : (row.citations as Citation[] | null) ?? [], systemQuery: !failure && !invalid && parsed?.success ? parsed.data : null };
}

type ContinuityTurn = { id?: string; role: "user" | "assistant"; text: string; citations: Citation[] };
type ContinuityQuestion = Pick<StudyContextAnchor, "attemptId" | "activityId" | "blockId" | "contentVersion">;

function mapContinuityRows(rows: readonly Record<string, unknown>[], scope: OpeningConversationScope): ContinuityTurn[] {
  return rows.map(row => {
    const display = queryDisplay(row, scope);
    return { id: row.id as string, role: row.role as ContinuityTurn["role"], text: display.text, citations: display.citations };
  });
}

const visibleTurnText = (db: Sql | TransactionSql) => db`CASE
  WHEN display_authority.inactive_misconception THEN ${INACTIVE_MISCONCEPTION_MESSAGE}
  WHEN t.role='assistant' AND display_authority.deleted_source THEN '关联材料已删除，此回答内容不再显示。'
  ELSE t.text END`;
const hiddenTurnDetails = (db: Sql | TransactionSql) => db`display_authority.deleted_source OR display_authority.inactive_misconception`;

async function redactMemoryMisconceptions<T extends Record<string, unknown>>(
  db: Sql | TransactionSql, scope: OpeningConversationScope, rows: readonly T[],
): Promise<T[]> {
  const ids = rows.flatMap(row => row.misconception_memory_turn_id ? [String(row.misconception_memory_turn_id)] : []);
  const invalid = await readTurnsWithInvalidMisconceptionMemories(db, scope, ids, { display: true });
  return rows.map(row => invalid.has(String(row.misconception_memory_turn_id)) ? {
    ...row, text: INACTIVE_MISCONCEPTION_MESSAGE, last_turn_preview: INACTIVE_MISCONCEPTION_MESSAGE,
    citations: [], system_query: null, exposure_receipt: null, pending_exposure_ids: [],
  } : row);
}

const memoryDisplayTurnId = (db: Sql | TransactionSql) => db`CASE WHEN t.role='assistant'
  AND NOT display_authority.inactive_misconception AND ${turnHasMisconceptionMemoryDependencies(db)} THEN t.id END`;
const batchedMemoryDisplayTurnId = (db: Sql | TransactionSql) => db`CASE WHEN t.role='assistant'
  AND NOT display_authority.inactive_misconception AND display_authority.has_memory_dependencies THEN t.id END`;

async function readContinuityRows(
  db: Sql | TransactionSql, scope: OpeningConversationScope, conversationId: string, question?: ContinuityQuestion,
  turnIds?: readonly string[],
) {
  const questionFilter = !question ? db`` : question.attemptId
    ? db`AND t.status='complete' AND (t.attempt_id=${question.attemptId} OR t.context_anchor->>'attemptId'=${question.attemptId})`
    : db`AND t.status='complete' AND t.context_anchor->>'activityId'=${question.activityId ?? null}
        AND t.context_anchor->>'blockId'=${question.blockId ?? null}
        AND t.context_anchor->>'contentVersion'=${question.contentVersion == null ? null : String(question.contentVersion)}`;
  const rows = await db`
    SELECT t.id,t.role,t.status,j.status AS job_status,j.error AS job_error,
      ${batchedMemoryDisplayTurnId(db)} AS misconception_memory_turn_id,
      ${visibleTurnText(db)} AS text,
      CASE WHEN ${hiddenTurnDetails(db)} THEN '[]'::jsonb ELSE t.citations END AS citations,
      CASE WHEN ${hiddenTurnDetails(db)} THEN NULL ELSE t.system_query END AS system_query
      ${turnIds ? db`, CASE WHEN t.role='assistant' AND t.status='complete' AND NOT (${hiddenTurnDetails(db)})
        THEN ARRAY(SELECT h.id FROM opening_help_exposures h WHERE h.turn_id=t.id AND h.workspace_id=t.workspace_id
          AND h.owner_user_id=c.owner_user_id AND h.exposure_origin='assistant'
          AND h.release_key IS NOT NULL AND h.released_at IS NULL ORDER BY h.id)
        ELSE '{}'::uuid[] END AS pending_exposure_ids` : db``}
    FROM opening_turns t
    JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id AND c.owner_user_id=${scope.ownerUserId}
    CROSS JOIN ${conversationMisconceptionLineage(db, scope.workspaceId, conversationId)}
    LEFT JOIN opening_tutor_jobs j ON j.assistant_turn_id=t.id AND j.workspace_id=t.workspace_id AND j.conversation_id=t.conversation_id
    LEFT JOIN opening_turns paired_u ON t.role='assistant' AND paired_u.id=j.user_turn_id
      AND paired_u.workspace_id=t.workspace_id AND paired_u.conversation_id=t.conversation_id
      AND paired_u.role='user' AND paired_u.status='complete'
    CROSS JOIN LATERAL (SELECT ${turnUsesDeletedSource(db)} AS deleted_source,
      ${conversationTurnInactiveMisconception(db, () => db`c.course_id`, () => db`c.owner_user_id`)} AS inactive_misconception,
      ${conversationTurnHasMisconceptionMemories(db)} AS has_memory_dependencies OFFSET 0) display_authority
    WHERE t.conversation_id=${conversationId} AND t.workspace_id=${scope.workspaceId}
      AND t.status IN ('complete', 'pending')
      ${questionFilter}
      ${turnIds ? db`AND t.id=ANY(${[...turnIds]}::uuid[]) ORDER BY array_position(${[...turnIds]}::uuid[], t.id)`
        : db`ORDER BY t.created_at ASC`}
  `;
  return redactMemoryMisconceptions(db, scope, rows);
}

export function createOpeningConversationRepository(sql: Sql) {
  const pendingExposureIds = (rows: readonly Record<string, unknown>[]) => rows.flatMap(row =>
    row.role === "assistant" && row.status === "complete" && row.exposure_receipt
      && (row.exposure_receipt as Record<string, unknown>).released_at == null
      ? [String((row.exposure_receipt as Record<string, unknown>).id)] : []);
  async function releaseReturnedExposures(tx: TransactionSql, scope: OpeningConversationScope, ids: string[]) {
    const receipts = new Map<string, StudyExposureReceipt>();
    for (const id of new Set(ids)) receipts.set(id, await releaseOpeningStudyExposure(tx, scope, id));
    return receipts;
  }
  return {
    async create(
      scope: OpeningConversationScope,
      input: ConversationCreateInput,
    ): Promise<{ id: string; title: string; courseId: string | null }> {
      const id = randomUUID();
      return sql.begin(async tx => {
        // Coordination uses the canonical owner, not INSERT's caller-supplied
        // owner. An ordinary lookup must precede history, never a business lock.
        const [workspace] = await tx`SELECT owner_user_id FROM workspaces WHERE id=${scope.workspaceId}`;
        if (workspace) {
          try {
            await lockWorkspaceLearningHistory(tx, { workspaceId: scope.workspaceId, ownerUserId: String(workspace.owner_user_id) });
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "NOT_FOUND" && error.message === "workspace not found")) throw error;
            // The workspace existed above: owner drift or deletion is a new
            // coordination conflict, not authorization or an INSERT retry.
            throw new OpeningConversationError("CONFLICT", "Conversation history coordination changed");
          }
          const [locked] = await tx`SELECT owner_user_id FROM workspaces WHERE id=${scope.workspaceId} FOR SHARE`;
          if (!locked || locked.owner_user_id !== workspace.owner_user_id) {
            throw new OpeningConversationError("CONFLICT", "Conversation history coordination changed");
          }
        }
        // Static absence still reaches the original INSERT (PG FK/CHECK/UUID
        // precedence); no history ensure can be committed by a failed INSERT.
        await tx`
          INSERT INTO opening_conversations (
            id, workspace_id, owner_user_id, title, course_id
          ) VALUES (
            ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.title}, ${input.courseId}
          )
        `;
        return { id, title: input.title, courseId: input.courseId };
      });
    },

    async getOwned(
      scope: OpeningConversationScope,
      conversationId: string,
    ): Promise<{
      id: string;
      title: string;
      courseId: string | null;
      updatedAt: string;
    }> {
      const rows = await sql`
        SELECT id, title, course_id, updated_at
        FROM opening_conversations
        WHERE id = ${conversationId}
          AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
        LIMIT 1
      `;
      if (!rows.length) {
        throw new OpeningConversationError(
          "NOT_FOUND",
          `Conversation not found: ${conversationId}`,
        );
      }
      const row = rows[0] as Record<string, unknown>;
      return {
        id: row.id as string,
        title: row.title as string,
        courseId: (row.course_id as string | null) ?? null,
        updatedAt: iso(row.updated_at as string | Date),
      };
    },

    async listSummaries(
      scope: OpeningConversationScope,
    ): Promise<ConversationSummary[]> {
      const readSummaries = (db: Sql | TransactionSql) => db`
        SELECT
          c.id,
          c.title,
          c.course_id,
          c.updated_at,
          preview.pending_exposure_ids, preview.misconception_memory_turn_id,
          preview.text AS last_turn_preview
        FROM opening_conversations c
        LEFT JOIN LATERAL (
            SELECT ${memoryDisplayTurnId(db)} AS misconception_memory_turn_id,
              CASE WHEN t.role='assistant' AND t.status='complete' AND NOT (${hiddenTurnDetails(db)})
              THEN ARRAY(
                SELECT h.id FROM opening_help_exposures h WHERE h.turn_id=t.id AND h.workspace_id=t.workspace_id
                  AND h.owner_user_id=c.owner_user_id
                  AND h.exposure_origin='assistant' AND h.release_key IS NOT NULL AND h.released_at IS NULL
                ORDER BY h.id
              ) ELSE '{}'::uuid[] END AS pending_exposure_ids,
              LEFT(
              CASE
                WHEN display_authority.inactive_misconception THEN ${INACTIVE_MISCONCEPTION_MESSAGE}
                WHEN t.role='assistant' AND display_authority.deleted_source
                  THEN '关联材料已删除，此回答内容不再显示。'
                WHEN t.role='assistant' AND (t.status='outcome_unknown' OR (t.status='pending' AND j.status='outcome_unknown')) THEN ${TUTOR_UNKNOWN_MESSAGE}
                WHEN t.role='assistant' AND t.status='clarify' THEN ${PAGE_CITATION_CLARIFY_MESSAGE}
                WHEN t.role='assistant' AND (t.status='failed' OR (t.status='pending' AND j.status IN ('failed','cancelled'))) THEN
                  CASE WHEN j.status='cancelled' THEN ${TUTOR_CANCELLED_MESSAGE} ELSE ${TUTOR_FAILURE_MESSAGE} END
                WHEN t.system_query IS NOT NULL THEN '系统记录查询快照，请打开核对回执。'
                ELSE coalesce(t.text, '')
              END,
              280
            ) AS text
            FROM (
              SELECT * FROM opening_turns t
              WHERE t.conversation_id = c.id AND t.workspace_id = c.workspace_id
              ORDER BY t.created_at DESC,t.id DESC LIMIT 1
            ) t
            CROSS JOIN LATERAL (SELECT ${turnUsesDeletedSource(db)} AS deleted_source,
              ${turnUsesInactiveMisconception(db)} AS inactive_misconception OFFSET 0) display_authority
            LEFT JOIN opening_tutor_jobs j ON j.assistant_turn_id=t.id AND j.workspace_id=t.workspace_id
        ) preview ON true
        WHERE c.workspace_id = ${scope.workspaceId}
          AND c.owner_user_id = ${scope.ownerUserId}
        ORDER BY c.updated_at DESC
      `;
      const pending = (rows: readonly Record<string, unknown>[]) =>
        rows.flatMap(row => (row.pending_exposure_ids as string[] | null | undefined) ?? []);
      const initial = await redactMemoryMisconceptions(sql, scope, await readSummaries(sql));
      const rows = pending(initial).length ? await sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const current = await redactMemoryMisconceptions(tx, scope, await readSummaries(tx));
        await releaseReturnedExposures(tx, scope, pending(current));
        return [...current];
      }) : initial;
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id as string,
          title: r.title as string,
          courseId: (r.course_id as string | null) ?? null,
          updatedAt: iso(r.updated_at as string | Date),
          lastTurnPreview: clipLastTurnPreview((r.last_turn_preview as string | null) ?? null),
        };
      });
    },

    async listTurns(
      scope: OpeningConversationScope,
      conversationId: string,
    ): Promise<TurnRecord[]> {
      await this.getOwned(scope, conversationId);
      const readTurns = (db: Sql | TransactionSql) => db`
        SELECT t.id, t.conversation_id, t.role,
          ${batchedMemoryDisplayTurnId(db)} AS misconception_memory_turn_id,
          ${visibleTurnText(db)} AS text,
          t.mode, t.status, j.status AS job_status, j.error AS job_error, t.created_at,t.context_anchor,
          CASE WHEN ${hiddenTurnDetails(db)} THEN NULL ELSE to_jsonb(h) END AS exposure_receipt,
          CASE WHEN ${hiddenTurnDetails(db)} THEN NULL ELSE t.system_query END AS system_query,
          CASE WHEN ${hiddenTurnDetails(db)} THEN '[]'::jsonb ELSE t.citations END AS citations
        FROM opening_turns t
        CROSS JOIN ${conversationMisconceptionLineage(db, scope.workspaceId, conversationId)}
        LEFT JOIN opening_help_exposures h ON h.turn_id=t.id AND h.workspace_id=t.workspace_id
          AND h.exposure_origin='assistant' AND h.release_key IS NOT NULL
        LEFT JOIN opening_tutor_jobs j
          ON j.workspace_id = t.workspace_id AND j.conversation_id = t.conversation_id
          AND (j.user_turn_id = t.id OR j.assistant_turn_id = t.id)
        LEFT JOIN opening_turns paired_u ON t.role = 'assistant' AND j.assistant_turn_id = t.id
          AND paired_u.id = j.user_turn_id AND paired_u.workspace_id = t.workspace_id
          AND paired_u.conversation_id = t.conversation_id AND paired_u.role = 'user' AND paired_u.status = 'complete'
        CROSS JOIN LATERAL (SELECT ${turnUsesDeletedSource(db)} AS deleted_source,
          ${conversationTurnInactiveMisconception(db)} AS inactive_misconception,
          ${conversationTurnHasMisconceptionMemories(db)} AS has_memory_dependencies OFFSET 0) display_authority
        WHERE t.conversation_id = ${conversationId}
          AND t.workspace_id = ${scope.workspaceId}
        -- Both turns share the transaction timestamp. Keep each job's pair
        -- together even when several jobs also have the same timestamp.
        ORDER BY t.created_at ASC, COALESCE(j.id, t.id) ASC,
          CASE WHEN t.id = j.user_turn_id THEN 0 ELSE 1 END ASC, t.id ASC
      `;
      const initial = await redactMemoryMisconceptions(sql, scope, await readTurns(sql));
      const mapTurns = (rows: readonly Record<string, unknown>[], released: ReadonlyMap<string, StudyExposureReceipt>) => rows.map((row): TurnRecord => {
        const r = row as Record<string, unknown>;
        const display = queryDisplay(r, scope);
        return {
          id: r.id as string,
          conversationId: r.conversation_id as string,
          role: r.role as TurnRecord["role"],
          text: display.text,
          citations: display.citations,
          createdAt: iso(r.created_at as string | Date),
          mode: r.mode as TutorMode,
          status: r.status as TurnRecord["status"],
          ...(r.exposure_receipt ? { exposureReceipt: released.get(String((r.exposure_receipt as Record<string, unknown>).id)) ?? mapOpeningStudyExposure(r.exposure_receipt as Record<string, unknown>) } : {}),
          ...(r.context_anchor ? { contextAnchor: r.context_anchor as StudyContextAnchor } : {}),
          systemQuery: display.systemQuery,
        };
      });
      if (!pendingExposureIds(initial).length) return mapTurns(initial, new Map());
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const rows = await redactMemoryMisconceptions(tx, scope, await readTurns(tx));
        return mapTurns(rows, await releaseReturnedExposures(tx, scope, pendingExposureIds(rows)));
      });
    },

    async releaseReturnedTurnIds(scope: OpeningConversationScope, conversationId: string, turnIds: readonly string[]): Promise<ContinuityTurn[] | void> {
      if (!turnIds.length) return [];
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const rows = await readContinuityRows(tx, scope, conversationId, undefined, turnIds);
        await releaseReturnedExposures(tx, scope, rows.flatMap(row => (row.pending_exposure_ids as string[] | undefined) ?? []));
        return mapContinuityRows(rows, scope);
      });
    },

    async loadContinuityTurns(
      scope: OpeningConversationScope,
      conversationId: string,
      question?: ContinuityQuestion,
    ): Promise<ContinuityTurn[]> {
      await this.getOwned(scope, conversationId);
      // Internal routing reads must never release generated answers as delivered help.
      return mapContinuityRows(await readContinuityRows(sql, scope, conversationId, question), scope);
    },

    async findTurnByClientKey(
      scope: OpeningConversationScope,
      clientKey: string,
      conversationId: string,
    ): Promise<{
      userTurnId: string;
      jobId: string;
      assistantTurnId: string;
      learningSessionId: string | null;
  attemptId?: string | null;
      mode?: TutorMode;
      purpose?: ComposerPurpose;
      querySystem?: boolean;
    } | null> {
      const rows = await sql`
        SELECT t.id AS turn_id, t.learning_session_id, t.mode, t.composer_purpose, t.query_system,
          j.id AS job_id, j.assistant_turn_id
        FROM opening_turns t
        LEFT JOIN opening_tutor_jobs j ON j.user_turn_id = t.id
        WHERE t.workspace_id = ${scope.workspaceId}
          AND t.client_key = ${clientKey}
          AND t.conversation_id = ${conversationId}
          AND t.role = 'user'
        LIMIT 1
      `;
      if (!rows.length) return null;
      const r = rows[0] as Record<string, unknown>;
      if (!r.job_id) return null;
      return {
        userTurnId: r.turn_id as string,
        jobId: r.job_id as string,
        assistantTurnId: r.assistant_turn_id as string,
        learningSessionId: (r.learning_session_id as string | null) ?? null,
        mode: r.mode as TutorMode,
        ...(r.composer_purpose ? { purpose: r.composer_purpose as ComposerPurpose } : {}),
        querySystem: r.query_system === true,
      };
    },

    async appendSavedTurn(input: {
      querySystem?: boolean;
      contextAnchor?: StudyContextAnchor;
      purpose?: ComposerPurpose;
      scope: OpeningConversationScope;
      conversationId: string;
      text: string;
      mode: TutorMode;
      clientKey: string;
      sourceIds: string[];
      learningSessionId: string | null;
  attemptId?: string | null;
      strategyTemplateId?: string | null;
      examHelpReplay?: ExamHelpReplay;
      currentPage: number | null;
      chunkId: string | null;
      privacy?: "saved";
    }): Promise<{ turnId: string; jobId: string; assistantTurnId: string; replayed?: true; learningSessionId?: string | null }> {
      const sourceIds = [...new Set(input.sourceIds)].sort();
      const turnId = randomUUID();
      const assistantTurnId = randomUUID();
      const jobId = randomUUID();

      return sql.begin(async (tx) => {
        // Preserve conversation-not-found precedence without taking a business
        // lock before the history fence. Recheck ownership under FOR UPDATE below.
        const owned = await tx`SELECT id FROM opening_conversations
          WHERE id=${input.conversationId} AND workspace_id=${input.scope.workspaceId}
            AND owner_user_id=${input.scope.ownerUserId}`;
        if (!owned.length) {
          throw new OpeningConversationError(
            "NOT_FOUND",
            `Conversation not found: ${input.conversationId}`,
          );
        }
        await lockWorkspaceLearningHistory(tx, input.scope);
        const conversations = await tx`
          SELECT id, course_id FROM opening_conversations
          WHERE id = ${input.conversationId}
            AND workspace_id = ${input.scope.workspaceId}
            AND owner_user_id = ${input.scope.ownerUserId}
          FOR UPDATE
        `;
        if (!conversations.length) {
          throw new OpeningConversationError(
            "NOT_FOUND",
            `Conversation not found: ${input.conversationId}`,
          );
        }

        const retryAssistantId = savedTurnRetryAssistantId(input.clientKey);
        const retryIntent = retryAssistantId
          ? await readOpeningSavedTurnRetry(tx, input.scope, input.conversationId, retryAssistantId)
          : null;
        if (retryAssistantId && (!retryIntent || !savedTurnRetryMatches(input, retryIntent))) {
          throw new OpeningConversationError("CONFLICT", "原失败轮的提问意图无法核实；请重新读取，或另发一条新问题。");
        }

        const examHelp = input.contextAnchor?.purpose === "exam_help";
        const examReplay = examHelp && !retryIntent ? input.examHelpReplay : undefined;
        const purpose = examHelp && !retryIntent && input.querySystem === true && input.purpose !== "explain_state"
          ? "query" : input.purpose;
        const querySystem = !examHelp && input.querySystem === true;
        const intentFor = (sourceVersions: Record<string, number>,
          kind: "current" | "legacy_exam" | "round4_exam" = "current"): SavedTurnIntent => {
          const requestedPurpose = examReplay?.requested.purpose;
          const intentPurpose = kind === "legacy_exam" ? examReplay?.legacyPurpose
            : kind === "round4_exam" ? requestedPurpose === "answer" || requestedPurpose === "teach" ? requestedPurpose : undefined
              : purpose;
          return {
            conversationId: input.conversationId,
            text: input.text,
            mode: input.mode,
            privacy: input.privacy ?? "saved",
            sourceIds,
            sourceVersions,
            currentPage: input.currentPage,
            chunkId: input.chunkId,
            learningSessionId: input.learningSessionId,
            ...(input.attemptId ? { attemptId: input.attemptId } : {}),
            ...(querySystem ? { querySystem: true as const } : {}),
            ...(input.contextAnchor ? { contextAnchor: input.contextAnchor } : {}),
            ...(intentPurpose ? { purpose: intentPurpose } : {}),
            ...(kind !== "legacy_exam" && examReplay ? { strategyTemplateId: input.strategyTemplateId ?? null, examRequest: examReplay.requested } : {}),
          };
        };
        const readReplay = async () => {
          const [existing] = await tx`
            SELECT t.id AS turn_id, t.intent_hash, t.source_versions,
                   j.id AS job_id, j.assistant_turn_id
            FROM opening_turns t
            LEFT JOIN opening_tutor_jobs j ON j.user_turn_id = t.id
            WHERE t.workspace_id = ${input.scope.workspaceId}
              AND t.client_key = ${input.clientKey}
              AND t.role = 'user'
            FOR UPDATE OF t
          `;
          return existing;
        };
        const resolveReplay = (existing: Record<string, unknown>) => {
          if (!existing.intent_hash || !existing.job_id) {
            throw new OpeningConversationError(
              "CONFLICT",
              existing.intent_hash ? "client key replay is unavailable" : "legacy client key cannot be replayed safely",
            );
          }
          const sourceVersions = existing.source_versions as Record<string, number>;
          const savedHash = String(existing.intent_hash);
          let matches = !examReplay?.replayOnly && savedHash === hashSavedTurnIntent(intentFor(sourceVersions));
          if (!matches && examReplay && !examReplay.replayOnly && examReplay.requested.querySystem !== true) {
            matches = savedHash === hashSavedTurnIntent(intentFor(sourceVersions, "legacy_exam"));
          }
          if (!matches && examReplay && !examReplay.replayOnly) {
            matches = savedHash === hashSavedTurnIntent(intentFor(sourceVersions, "round4_exam"));
          }
          let legacyQueryMatched = false;
          if (!matches && examReplay?.legacyQuery) {
            // Older record queries used a different projection of the same submitted request.
            const { text, mode, sourceIds: querySources, purpose: queryPurpose, currentPage } = examReplay.legacyQuery;
            const legacyQuery: SavedTurnIntent = { conversationId: input.conversationId, text, mode,
              privacy: input.privacy ?? "saved", sourceIds: [...new Set(querySources)].sort(), sourceVersions,
              currentPage, chunkId: null, learningSessionId: null, querySystem: true,
              contextAnchor: input.contextAnchor, purpose: queryPurpose };
            legacyQueryMatched = savedHash === hashSavedTurnIntent(legacyQuery);
          }
          if (!matches && !legacyQueryMatched) throw new OpeningConversationError("CONFLICT", "client key intent differs from the saved turn");
          return {
            turnId: existing.turn_id as string,
            jobId: existing.job_id as string,
            assistantTurnId: existing.assistant_turn_id as string,
            ...(examHelp ? { replayed: true as const, ...(legacyQueryMatched ? { learningSessionId: null } : {}) } : {}),
          };
        };
        // An exam replay can predate the current material and attempt admission rules.
        if (examHelp && !retryIntent) {
          const replay = await readReplay();
          if (replay) return resolveReplay(replay);
          if (examReplay?.replayOnly) throw new OpeningConversationError("CONFLICT", "client key replay is unavailable");
        }

        if (input.learningSessionId) {
          const sessions = await tx`SELECT course_id FROM opening_learning_sessions
            WHERE id=${input.learningSessionId} AND workspace_id=${input.scope.workspaceId}
              AND owner_user_id=${input.scope.ownerUserId} FOR SHARE`;
          if (!sessions.length) throw new OpeningConversationError("VALIDATION", "learning session not found");
          if (conversations[0]!.course_id !== null && conversations[0]!.course_id !== sessions[0]!.course_id) {
            throw new OpeningConversationError("VALIDATION", "learning session and conversation courses differ");
          }
        }
        if (input.attemptId) {
          const attempts = await tx`SELECT id, course_id FROM opening_learning_attempts WHERE id=${input.attemptId}
            AND workspace_id=${input.scope.workspaceId} AND owner_user_id=${input.scope.ownerUserId}
            AND session_id=${input.learningSessionId} FOR SHARE`;
          if (!attempts.length) throw new OpeningConversationError("VALIDATION", "attempt/session mismatch");
          if (conversations[0]!.course_id !== attempts[0]!.course_id) {
            throw new OpeningConversationError("VALIDATION", "attempt requires a conversation assigned to the same course");
          }
        }
        const anchorSelection = input.contextAnchor ?? (input.attemptId ? { purpose: "learning_help" as const, attemptId: input.attemptId } : undefined);
        const contextAnchor = anchorSelection ? await resolveOpeningStudyContext(tx, input.scope, anchorSelection, {
          courseId: conversations[0]!.course_id as string | null, sessionId: input.learningSessionId,
          attemptId: input.attemptId, sourceIds,
        }) : undefined;
        if (contextAnchor && (input.currentPage != null && contextAnchor.page != null && input.currentPage !== contextAnchor.page
          || input.chunkId != null && contextAnchor.chunkId != null && input.chunkId !== contextAnchor.chunkId)) {
          throw new OpeningConversationError("CONFLICT", "page selection differs from study context");
        }
        if (!examHelp || retryIntent) {
          const replay = await readReplay();
          if (replay) return resolveReplay(replay);
        }

        const sourceRows = sourceIds.length
          ? await tx`
              SELECT id, version
              FROM opening_sources
              WHERE workspace_id = ${input.scope.workspaceId}
                AND id IN ${tx(sourceIds)}
                AND upload_state = 'uploaded'
                AND parse_state = 'ready'
              ORDER BY id
              FOR SHARE
            `
          : [];
        if (sourceRows.length !== sourceIds.length) {
          throw new OpeningConversationError(
            "NOT_FOUND",
            "one or more requested sources are unavailable",
          );
        }
        const sourceVersions = Object.fromEntries(
          sourceRows.map((row) => [String((row as Record<string, unknown>).id), Number((row as Record<string, unknown>).version)]),
        );
        if (retryIntent && (Object.keys(retryIntent.sourceVersions).length !== sourceIds.length
          || sourceIds.some(id => sourceVersions[id] !== retryIntent.sourceVersions[id]))) {
          throw new OpeningConversationError("CONFLICT", "原提问资料版本已变化；未改用新版本重试，请确认后另发新问题。");
        }
        if (contextAnchor?.sourceId && contextAnchor.sourceVersion != null) sourceVersions[contextAnchor.sourceId] = contextAnchor.sourceVersion;
        if (contextAnchor?.activityId && contextAnchor.contentVersion != null) {
          const [spec] = await tx`SELECT source_refs FROM opening_teaching_activity_specs WHERE workspace_id=${input.scope.workspaceId}
            AND owner_user_id=${input.scope.ownerUserId} AND activity_id=${contextAnchor.activityId} AND version=${contextAnchor.contentVersion} FOR SHARE`;
          for (const ref of (spec?.source_refs ?? []) as Array<{ sourceId: string; version?: number | string | null }>) {
            if (sourceIds.includes(ref.sourceId) && ref.version != null && Number.isInteger(Number(ref.version))) sourceVersions[ref.sourceId] = Number(ref.version);
          }
        }
        const intentHash = hashSavedTurnIntent(intentFor(sourceVersions));
        const sourceVersionsJson = tx.json(sourceVersions as never);

        const inserted = await tx`
          INSERT INTO opening_turns (
            id, workspace_id, conversation_id, role, text, mode, status,
            client_key, learning_session_id, current_page, chunk_id, source_ids,
            intent_hash, source_versions, attempt_id, strategy_template_id,query_system,context_anchor,composer_purpose
          ) VALUES (
            ${turnId}, ${input.scope.workspaceId}, ${input.conversationId},
            'user', ${input.text}, ${input.mode}, 'complete',
            ${input.clientKey}, ${input.learningSessionId}, ${input.currentPage},
            ${input.chunkId}, ${sourceIds}, ${intentHash}, ${sourceVersionsJson}, ${input.attemptId ?? null},
            ${input.strategyTemplateId ?? null},${querySystem},${contextAnchor ? tx.json(contextAnchor) : null},${purpose ?? null}
          )
          ON CONFLICT (workspace_id, client_key) WHERE client_key IS NOT NULL
          DO NOTHING
          RETURNING id
        `;
        if (!inserted.length) {
          const existing = await readReplay();
          if (!existing) {
            throw new OpeningConversationError("CONFLICT", "client key replay is unavailable");
          }
          return resolveReplay(existing);
        }

        await tx`
          INSERT INTO opening_turns (
            id, workspace_id, conversation_id, role, text, mode, status,
            client_key, learning_session_id, current_page, chunk_id, source_ids,
            source_versions, attempt_id, strategy_template_id,query_system,context_anchor,composer_purpose
          ) VALUES (
            ${assistantTurnId}, ${input.scope.workspaceId}, ${input.conversationId},
            'assistant', '', ${input.mode}, 'pending',
            NULL, ${input.learningSessionId}, ${input.currentPage},
            ${input.chunkId}, ${sourceIds}, ${sourceVersionsJson}, ${input.attemptId ?? null},
            ${input.strategyTemplateId ?? null},${querySystem},${contextAnchor ? tx.json(contextAnchor) : null},${purpose ?? null}
          )
        `;
        await tx`
          INSERT INTO opening_tutor_jobs (
            id, workspace_id, conversation_id, user_turn_id, assistant_turn_id,
            status, mode
          ) VALUES (
            ${jobId}, ${input.scope.workspaceId}, ${input.conversationId},
            ${turnId}, ${assistantTurnId}, 'queued', ${input.mode}
          )
        `;
        await tx`
          UPDATE opening_conversations
          SET updated_at = now()
          WHERE id = ${input.conversationId}
            AND workspace_id = ${input.scope.workspaceId}
        `;

        return { turnId, jobId, assistantTurnId };
      });
    },
  };
}

export type OpeningConversationRepository = ReturnType<
  typeof createOpeningConversationRepository
>;
