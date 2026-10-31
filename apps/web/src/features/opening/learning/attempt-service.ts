import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, learningAttemptContextReadSchema, photoWorkSourceInputSchema, photoWorkSourceResponseSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import {
  createOpeningKnowledgeRepository,
  createOpeningLearningAttemptRepository,
  createOpeningLearningRepository,
  createOpeningStudyContextRepository,
  createOpeningSpanSessionRepository,
  readOpeningAttemptGradingUsesVision,
} from "@aistudy/database";
import { assertRetestSubmitEarliestAllowed, prepareRetestSkillLink, resolveAssistance } from "@aistudy/domain";
import type { Sql } from "postgres";
import { resolveAutoGradePolicy } from "./auto-grade-policy";

function highestDeliveredAssistance(exposures: ReadonlyArray<"hinted" | "revealed">): "none" | "hinted" | "revealed" {
  if (exposures.includes("revealed")) return "revealed";
  if (exposures.includes("hinted")) return "hinted";
  return "none";
}

function notFound(message: string): never {
  throw Object.assign(new Error(message), { code: "NOT_FOUND" as const });
}

function validation(message: string): never {
  throw Object.assign(new Error(message), { code: "VALIDATION" as const });
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Load retest timing floors for submit earliest check (scoped by workspace owner). */
async function loadRetestSubmitEarliestTimes(sql: Sql, scope: Scope, retestId: string) {
  const rows = await sql`
    SELECT not_before_at, recommended_at, scheduled_start_at
    FROM opening_retest_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND (candidate_id=${retestId} OR id=${retestId} OR candidate_reference_id=${retestId})
  `;
  if (rows.length !== 1) validation("retest activity is missing or ambiguous");
  const row = rows[0] as {
    not_before_at: unknown;
    recommended_at: unknown;
    scheduled_start_at: unknown;
  };
  return {
    notBeforeAt: isoOrNull(row.not_before_at),
    recommendedAt: isoOrNull(row.recommended_at),
    scheduledStartAt: isoOrNull(row.scheduled_start_at),
  };
}

export function createOpeningAttemptService(sql: Sql) {
  const attempts = createOpeningLearningAttemptRepository(sql);
  const learning = createOpeningLearningRepository(sql);
  const knowledge = createOpeningKnowledgeRepository(sql);
  return {
    create(scope: Scope, raw: unknown) { return attempts.create(scope, learningAttemptCreateInputSchema.parse(raw)); },
    async get(scope: Scope, id: string) {
      const attempt = await attempts.get(scope, uuidSchema.parse(id));
      if (!attempt) notFound("attempt not found");
      const exposures = await learning.listDeliveredExposures(scope, attempt.sessionId, { attemptId: attempt.id, assessmentDomain: attempt.requirementKey?.startsWith("language:") ? "language" : "math" });
      return {
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        deliveredAssistance: highestDeliveredAssistance(exposures),
      };
    },
    async getContext(scope: Scope, id: string) {
      const attempt = await attempts.assertAccess(scope, uuidSchema.parse(id));
      const contextAnchor = await createOpeningStudyContextRepository(sql).resolve(scope,
        attempt.contextAnchor ?? { purpose: "learning_help" },
        { attemptId: attempt.id, sessionId: attempt.sessionId, courseId: attempt.courseId, sourceIds: attempt.sourceIds });
      const exposures = await learning.listDeliveredExposures(scope, attempt.sessionId, {
        attemptId: attempt.id, assessmentDomain: attempt.requirementKey?.startsWith("language:") ? "language" : "math",
      });
      const result = learningAttemptContextReadSchema.safeParse({ attempt: { ...attempt, contextAnchor },
        deliveredAssistance: highestDeliveredAssistance(exposures) });
      if (!result.success) validation("本次作答缺少可验证的题目或材料版本，请返回原题重新打开。");
      return result.data;
    },
    /** Validate an uploaded answer photo for this attempt without submitting or persisting an observation. */
    async preparePhotoWorkSource(scope: Scope, id: string, raw: unknown) {
      const input = photoWorkSourceInputSchema.parse(raw);
      const attempt = await attempts.assertAccess(scope, uuidSchema.parse(id));
      // Same admission rule as submit (admitOpeningAiGradingWorkSource): a workspace upload, never a
      // course membership. Course membership would turn answer photos into course knowledge sources.
      const [row] = await sql`SELECT s.id,s.version,s.mime,s.parse_state,s.upload_state
        FROM opening_sources s
        WHERE s.id=${input.sourceId} AND s.workspace_id=${scope.workspaceId}
          AND s.upload_state='uploaded'
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
        LIMIT 1`;
      if (!row || Number(row.version) !== input.sourceVersion) {
        throw Object.assign(new Error("作答照片版本已过期或不可读取"), { code: "CONFLICT" as const });
      }
      const parseState = String(row.parse_state) as "not_started" | "queued" | "running" | "ready" | "failed" | "unsupported";
      const mime = String(row.mime);
      if (["image/jpeg", "image/png", "image/webp"].includes(mime) && input.physicalPage !== 1) {
        throw Object.assign(new Error("单张作答照片的页码必须为1"), { code: "VALIDATION" as const });
      }
      if (mime !== "application/pdf" && !["image/jpeg", "image/png", "image/webp"].includes(mime)) {
        throw Object.assign(new Error("作答照片仅支持 JPG、PNG、WebP 或 PDF"), { code: "VALIDATION" as const });
      }
      if (mime === "application/pdf" && parseState === "ready") {
        const [page] = await sql`SELECT id FROM opening_source_chunks WHERE source_id=${input.sourceId}
          AND source_version=${input.sourceVersion} AND page=${input.physicalPage} LIMIT 1`;
        if (!page) throw Object.assign(new Error("作答 PDF 的页码不可读取"), { code: "CONFLICT" as const });
      }
      const state = parseState === "ready" ? "ready" : parseState === "failed" || parseState === "unsupported" ? "unavailable" : "pending";
      return photoWorkSourceResponseSchema.parse({ attemptId: attempt.id, courseId: attempt.courseId,
        workSource: { id: String(row.id), version: Number(row.version), physicalPage: input.physicalPage }, state, parseState });
    },
    async submit(scope: Scope, id: string, raw: unknown) {
      const input = learningAttemptSubmitInputSchema.parse(raw);
      const attempt = await attempts.assertAccess(scope, uuidSchema.parse(id));
      const exposures = await learning.listDeliveredExposures(scope, attempt.sessionId, { attemptId: attempt.id, assessmentDomain: attempt.requirementKey?.startsWith("language:") ? "language" : "math" });
      const visualReference = attempt.itemVersionId && !attempt.submittedAt ? await readOpeningAttemptGradingUsesVision(sql, scope, attempt.id) : false;
      const resolvedPolicy = await resolveAutoGradePolicy(sql, scope, Boolean(input.workSource) || visualReference === true);
      const autoGrade = visualReference === null ? { ...resolvedPolicy, modelAvailable: false,
        modelUnavailableReason: "no_model" as const, primaryModel: null, fallbackModel: null } : resolvedPolicy;
      const [reported] = attempt.spanExercise ? await sql`SELECT id FROM opening_study_intent_events WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND attempt_id=${attempt.id} AND payload->'signals' @> '["copied_answer"]'::jsonb LIMIT 1` : [];
      const assistance = resolveAssistance(reported ? "revealed" : input.assistance, exposures);
      const { preAnswerConfidence, ...observationInput } = input;
      const confidenceOptions = preAnswerConfidence == null ? {} : { preAnswerConfidence };
      const base = {
        ...observationInput,
        assistance,
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        courseId: attempt.courseId,
        skillLabel: attempt.skillLabel,
        sourceIds: attempt.sourceIds,
        problemId: attempt.problemId,
      };
      // Span's canonical evaluation and retest binding are checked together in
      // the observation transaction. Keep the learner's original request level
      // separate from help delivered later so an exact retry remains a replay.
      const spanLesson = attempt.spanExercise && attempt.contextAnchor?.activityId
        ? await createOpeningSpanSessionRepository(sql).get(scope, attempt.contextAnchor.activityId) : null;
      if (spanLesson?.sessionId === attempt.sessionId) return learning.insertObservation(scope, base, { ...confidenceOptions, autoGrade, submittedAssistance: input.assistance, workSource: input.workSource });
      // K02 L02 close: resolve nodeId for independent retest so Data links SkillEvidence in the same tx.
      if (!input.retestId) {
        return learning.insertObservation(scope, base, { ...confidenceOptions, autoGrade, workSource: input.workSource });
      }
      // DL11: server re-checks earliest-allowed before inserting observation (UI disable is not a guarantee).
      const earliestTimes = await loadRetestSubmitEarliestTimes(sql, scope, input.retestId);
      assertRetestSubmitEarliestAllowed(earliestTimes, new Date());
      const current = await knowledge.get(scope, attempt.courseId);
      // V2-13: dimension must be explicit (domain no longer defaults transfer).
      const skillLink = prepareRetestSkillLink({
        retestId: input.retestId,
        assistance,
        outcome: input.outcome,
        skillLabel: attempt.skillLabel,
        dimension: "transfer",
        snapshot: current?.snapshot ?? null,
      });
      return learning.insertObservation(
        scope,
        skillLink ? { ...base, nodeId: skillLink.nodeId, dimension: skillLink.dimension } : base,
        { ...confidenceOptions, autoGrade, workSource: input.workSource },
      );
    },
  };
}
