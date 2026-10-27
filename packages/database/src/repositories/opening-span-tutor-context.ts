import type { Scope, SpanLessonSnapshot, StudySessionIntent } from "@aistudy/contracts";
import { DEFAULT_STUDY_SESSION_INTENT, nextLearningStep, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL, spanModeForIntent,
  studyIntentForMessage, toSnapshotEvidence, type NextLearningStep, type NextLearningStepInput } from "@aistudy/domain";
import type { SnapshotObservation } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { isDeepStrictEqual } from "node:util";
import { contextSourceRefsIncluded, mergeContextSourceRefs, type ContextSourceRef } from "./opening-context-provenance";
import { admitLearningSources, learningError, lockLearningOwner } from "./opening-learning-facts";
import { readOpeningCourseEvidence } from "./opening-learning-read";
import { createOpeningSpanSessionRepository } from "./opening-span-session";
import { createOpeningRetestActivityRepository } from "./opening-retest-activities";
import { readSpanTutorAuthorization, lockSpanTutorAuthorization } from "./opening-span-tutor-grant";
import { reserveSpanTutorActivityBudget } from "./opening-span-tutor-budget";
import { readOpeningSpanReservedChoice } from "./opening-span-reserved-selection";
import { parseOpeningSpanExercise } from "./opening-span-attempt";
import { readOpeningSpanTutorOrigin, readOpeningSpanTutorOriginChange, type OpeningSpanTutorOriginReference, type OpeningSpanTutorOriginChange } from "./opening-span-tutor-origin";
import { createOpeningLearningAttemptInTx } from "./opening-learning-attempts";

export type OpeningSpanTutorRequest = {
  courseId: string; sourceIds: readonly string[]; sourceVersions: Record<string, number>; question: string;
  originReference?: OpeningSpanTutorOriginReference;
};
export type OpeningSpanTutorContext = {
  courseId: string; grantRevision: number; privacyEpoch: number;
  sourceRefs: ContextSourceRef[]; sourceIds: string[]; sourceVersions: Record<string, number>;
  decisionInput: NextLearningStepInput; intent: StudySessionIntent;
  resumeSession: SpanLessonSnapshot | null; dueRetestId: string | null;
  unseenUnavailableReason?: "unknown_history" | "exhausted";
  originReference?: OpeningSpanTutorOriginReference;
  originSnapshotRevision?: number;
  needsReservedIssue?: boolean;
  originChange?: OpeningSpanTutorOriginChange;
};
export type OpeningSpanTutorExecuteInput = {
  context: OpeningSpanTutorContext; decision: NextLearningStep; operationId: string;
  jobLease?: { jobId: string; claimToken: string };
};

const conflict = (message: string) => learningError("CONFLICT", message);
export function spanTutorQuestionInScope(question: string): boolean {
  return /\bspan\b|线性组合|张成(?:空间|集合)?/i.test(question)
    || /^(?:请|帮我|我想)?(?:继续(?:学习|上次(?:学习)?|原来的学习)?|下一步|开始(?:本次学习|学习|练习)|出一道题|从哪里开始)[\s。！!？?]*$/u.test(question.trim());
}
export function spanTutorExactProjection(rows: SnapshotObservation[], evaluations: Array<{ id: string; evaluatorVersion: string | null }>) {
  const exact = new Set(evaluations.filter(row => row.evaluatorVersion === "span-exact-v1").map(row => row.id));
  return rows.map(row => {
    if (exact.has(row.id)) return row;
    const { errors: _errors, ...facts } = row;
    return { ...facts, verifiedCorrect: "unknown" as const };
  });
}
/** Existing repositories keep their savepoints inside the caller's authorization/budget transaction. */
function transactionClient(tx: TransactionSql): Sql {
  return new Proxy(tx, { get(target, key, receiver) {
    if (key === "begin") return (...args: unknown[]) => target.savepoint(nested =>
      (args.at(-1) as (value: TransactionSql) => Promise<unknown>)(nested));
    return Reflect.get(target, key, receiver);
  } }) as unknown as Sql;
}
async function selectedSources(tx: TransactionSql, scope: Scope, courseId: string, ids: readonly string[], versions?: Record<string, number>) {
  const rows = await tx`SELECT s.id,s.version FROM course_asset_memberships m JOIN opening_sources s
      ON s.id=m.asset_id AND s.workspace_id=m.workspace_id
    WHERE m.workspace_id=${scope.workspaceId} AND m.course_id=${courseId} AND m.asset_type='source'
      AND (${ids.length === 0} OR s.id=ANY(${[...ids]}::uuid[]))
      AND s.upload_state='uploaded' AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
    ORDER BY s.id LIMIT 33`;
  if (!rows.length || rows.length > 32 || ids.length && rows.length !== ids.length) throw conflict("课程材料不可用或范围已变化，请重新选择可用材料。");
  for (const row of rows) if (ids.length && versions && versions[String(row.id)] !== Number(row.version)) throw conflict("课程材料版本已变化，请重新读取后继续。");
  const sourceIds = rows.map(row => String(row.id)), sourceVersions = Object.fromEntries(rows.map(row => [String(row.id), Number(row.version)]));
  await admitLearningSources(tx, scope, sourceIds, { readOnly: true, recordVersions: false });
  return { sourceIds, sourceVersions };
}
async function facts(tx: TransactionSql, scope: Scope, courseId: string, sourceIds: string[], sourceVersions: Record<string, number>, wantsFullExplanation: boolean, focusObservationId?: string | null) {
  const db = transactionClient(tx);
  await selectedSources(tx, scope, courseId, sourceIds, sourceVersions);
  const all = await readOpeningCourseEvidence(db, scope, courseId);
  const observations = all.observations.filter(row => row.requirementKey === SPAN_REQUIREMENT_KEY && row.skillLabel === SPAN_SKILL_LABEL);
  const projected = toSnapshotEvidence({ observations, evidenceContexts: all.evidenceContexts }, new Date());
  const current = spanTutorExactProjection(projected.observations, observations.map(row => ({ id: row.id,
    evaluatorVersion: row.serverEvaluation?.evaluatorVersion ?? null }))).filter(row => row.usableForCurrentVersion === "yes")
    .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt) || a.id.localeCompare(b.id));
  const roots = observations.filter(row => current.some(item => item.id === row.id)).map(row => row.rootObservationId ?? row.id);
  const lineage = roots.length ? await db`SELECT source_ids,source_versions,reference_source_id,reference_check
    FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND COALESCE(root_observation_id,id)=ANY(${roots}::uuid[]) ORDER BY id` : [];
  const origins: ContextSourceRef[] = sourceIds.map(sourceId => ({ sourceId, sourceVersion: sourceVersions[sourceId]! }));
  for (const row of lineage) {
    const captured = (row.source_versions ?? {}) as Record<string, unknown>;
    const check = row.reference_check as { referenceId?: string } | null;
    for (const sourceId of new Set([...(row.source_ids as string[]), ...Object.keys(captured),
      ...(row.reference_source_id ? [String(row.reference_source_id)] : []), ...(check?.referenceId ? [check.referenceId] : [])])) {
      const version = captured[sourceId];
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw conflict("学习记录的材料版本暂不可确认，请先核对原记录。");
      origins.push({ sourceId, sourceVersion: version });
    }
  }
  const sourceRefs = mergeContextSourceRefs(origins).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.sourceVersion - b.sourceVersion);
  if (sourceRefs.length > 960) throw conflict("关联学习记录过多，请缩小课程材料范围。");
  const [admitted] = await db`SELECT 1 AS ok WHERE ${contextSourceRefsIncluded(db, scope.workspaceId, db`${db.json(sourceRefs)}`)}`;
  if (!admitted) throw conflict("学习记录关联材料已变化，请重新读取后继续。");
  // An explicit continuation answers this activity's result. A newer session
  // can inform later course planning, but cannot replace the selected origin.
  const selected = focusObservationId ? current.filter(row => row.id === focusObservationId) : current;
  const decisionInput: NextLearningStepInput = { observations: selected, wantsFullExplanation,
    status: !selected.length ? "unobserved" : selected[0]!.verifiedCorrect === "yes" && selected[0]!.independentAttempt === "yes" ? "observed_independent" : "needs_check" };
  return { sourceRefs, decisionInput };
}
async function nextSession(db: Sql, scope: Scope, courseId: string) {
  const sessions = createOpeningSpanSessionRepository(db), unfinished = await sessions.latest(scope, courseId);
  if (unfinished) return { resumeSession: unfinished, dueRetestId: null };
  const due = (await createOpeningRetestActivityRepository(db).listDue(scope, courseId, new Date().toISOString()))
    .find(row => row.requirementKey === SPAN_REQUIREMENT_KEY && row.skillLabel === SPAN_SKILL_LABEL);
  return { resumeSession: due ? await sessions.latest(scope, courseId, due.activityId) : null, dueRetestId: due?.activityId ?? null };
}
async function reservedChoice(db: Sql, scope: Scope, session: SpanLessonSnapshot | null, intent: StudySessionIntent, decision: NextLearningStep, dueRetestId: string | null) {
  if (session) {
    if (session.status === "paused") return null;
    if (!session.moveId.endsWith("-reserved")) return null;
    const attempts = await db`SELECT v.evaluation_spec FROM opening_learning_attempts a
      JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
      WHERE a.session_id=${session.sessionId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
    if (attempts.some(row => parseOpeningSpanExercise(row.evaluation_spec)?.id.startsWith("span-reserved-"))) return null;
  } else if (!dueRetestId && ["full_explain", "targeted_explain"].includes(decision.activityKind)) return null;
  return readOpeningSpanReservedChoice(db, scope, spanModeForIntent(intent));
}
async function assertContext(tx: TransactionSql, scope: Scope, context: OpeningSpanTutorContext) {
  const db = transactionClient(tx);
  const authorization = await readSpanTutorAuthorization(db, scope, context.courseId);
  if (!authorization.authorized || authorization.grant?.revision !== context.grantRevision) throw conflict("导师试用授权已变化，请重新读取后继续。");
  const [workspace] = await db`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!workspace || Number(workspace.privacy_epoch) !== context.privacyEpoch) throw conflict("材料隐私范围已变化，请重新读取后继续。");
  if (context.resumeSession) {
    const session = await createOpeningSpanSessionRepository(db).get(scope, context.resumeSession.activityId);
    if (!session || !isDeepStrictEqual(session, context.resumeSession)) throw conflict("学习活动已在另一处更新，请重新读取后继续。");
    const changed = await readOpeningSpanTutorOriginChange(db, scope, session.activityId);
    if (changed || context.originChange) {
      if (changed && isDeepStrictEqual(changed, context.originChange)) return;
      throw Object.assign(conflict("原评价或材料已变化，请重新加载后重新选择下一步。"), { originChange: changed });
    }
  }
  if (context.originReference) await readOpeningSpanTutorOrigin(db, scope, context.originReference, context.courseId, context.originSnapshotRevision);
  const current = await facts(tx, scope, context.courseId, context.sourceIds, context.sourceVersions, context.decisionInput.wantsFullExplanation, context.originReference?.observationId);
  if (!isDeepStrictEqual(current.decisionInput, context.decisionInput) || !isDeepStrictEqual(current.sourceRefs, context.sourceRefs)) throw conflict("有效学习记录或帮助事实已变化，请重新读取后继续。");
  if (context.resumeSession) {
    const session = await createOpeningSpanSessionRepository(db).get(scope, context.resumeSession.activityId);
    if (!session || !isDeepStrictEqual(session, context.resumeSession)) throw conflict("学习活动已在另一处更新，请重新读取后继续。");
    await selectedSources(tx, scope, context.courseId, session.sourceIds,
      Object.fromEntries(session.sourceIds.map(id => [id, context.sourceVersions[id]!])));
  }
  if (context.dueRetestId) {
    const due = await createOpeningRetestActivityRepository(db).listDue(scope, context.courseId, new Date().toISOString());
    if (!due.some(row => row.activityId === context.dueRetestId && row.requirementKey === SPAN_REQUIREMENT_KEY)) throw conflict("复测已推迟、取消或更新，请重新读取后继续。");
  }
}

export function createOpeningSpanTutorContextRepository(sql: Sql) {
  return {
    async read(scope: Scope, request: OpeningSpanTutorRequest): Promise<OpeningSpanTutorContext | null> {
      if (!spanTutorQuestionInScope(request.question)) return null;
      return sql.begin("isolation level repeatable read read only", async tx => {
        const authorization = await readSpanTutorAuthorization(tx, scope, request.courseId);
        if (!authorization.authorized || !authorization.grant) return null;
        const db = transactionClient(tx);
        const origin = request.originReference ? await readOpeningSpanTutorOrigin(db, scope, request.originReference, request.courseId) : null;
        const position = origin ? { resumeSession: null, dueRetestId: null } : await nextSession(db, scope, request.courseId);
        if (position.resumeSession) {
          const originChange = await readOpeningSpanTutorOriginChange(db, scope, position.resumeSession.activityId);
          if (originChange) {
            const [workspace] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
            return { courseId: request.courseId, grantRevision: authorization.grant.revision, privacyEpoch: Number(workspace!.privacy_epoch),
              sourceIds: position.resumeSession.sourceIds, sourceVersions: {}, sourceRefs: [], intent: position.resumeSession.intent,
              decisionInput: { observations: [], status: "unobserved", wantsFullExplanation: false }, ...position, originChange };
          }
        }
        const selected = origin ? await selectedSources(tx, scope, request.courseId, origin.session.sourceIds)
          : position.resumeSession ? await selectedSources(tx, scope, request.courseId, position.resumeSession.sourceIds)
          : await selectedSources(tx, scope, request.courseId, request.sourceIds, request.sourceVersions);
        const sourceIds = position.resumeSession?.sourceIds ?? selected.sourceIds;
        const sourceVersions = Object.fromEntries(sourceIds.map(id => [id, selected.sourceVersions[id]!]));
        const intent = origin?.session.intent ?? position.resumeSession?.intent ?? studyIntentForMessage(null, request.question)?.intent ?? { ...DEFAULT_STUDY_SESSION_INTENT };
        const projection = await facts(tx, scope, request.courseId, sourceIds, sourceVersions, intent.explanationStyle === "full", request.originReference?.observationId);
        const [workspace] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        const decision = nextLearningStep(projection.decisionInput);
        const reserved = await reservedChoice(db, scope, position.resumeSession, intent, decision, position.dueRetestId);
        return { courseId: request.courseId, grantRevision: authorization.grant.revision, privacyEpoch: Number(workspace!.privacy_epoch),
          ...(request.originReference ? { originReference: request.originReference, originSnapshotRevision: origin!.session.revision } : {}),
          ...(reserved?.kind === "unavailable" ? { unseenUnavailableReason: reserved.reason } : {}),
          ...(position.resumeSession && reserved?.kind === "available" ? { needsReservedIssue: true } : {}),
          sourceIds, sourceVersions, intent, ...projection, ...position };
      }) as Promise<OpeningSpanTutorContext | null>;
    },
    async assertCurrent(scope: Scope, context: OpeningSpanTutorContext): Promise<void> {
      await sql.begin("isolation level repeatable read read only", tx => assertContext(tx, scope, context));
    },
    async execute(scope: Scope, input: OpeningSpanTutorExecuteInput): Promise<SpanLessonSnapshot> {
      return sql.begin(async tx => {
        const { context } = input;
        await lockSpanTutorAuthorization(tx, scope, context.courseId, context.grantRevision);
        await lockLearningOwner(tx, scope);
        if (input.jobLease) {
          const [job] = await tx`SELECT id FROM opening_tutor_jobs WHERE id=${input.jobLease.jobId}
            AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='running'
            AND claim_token=${input.jobLease.claimToken} FOR UPDATE`;
          if (!job) throw conflict("教学请求已结束或被取消，未新增学习活动。");
        }
        const db = transactionClient(tx), sessions = createOpeningSpanSessionRepository(db);
        await assertContext(tx, scope, context);
        if (context.originChange) throw Object.assign(conflict("原评价或材料已变化，请先重新选择下一步；已有学习记录保留。"), { originChange: context.originChange });
        if (!isDeepStrictEqual(input.decision, nextLearningStep(context.decisionInput))) throw conflict("下一活动选择已变化，请重新读取后继续。");
        if (!context.resumeSession && !context.originReference) {
          const position = await nextSession(db, scope, context.courseId);
          if (position.resumeSession) {
            context.resumeSession = position.resumeSession;
            await assertContext(tx, scope, context);
          } else if (position.dueRetestId !== context.dueRetestId) throw conflict("当前到期复测已变化，请重新读取后继续。");
        }
        const availability = await reservedChoice(db, scope, context.resumeSession, context.intent, input.decision, context.dueRetestId);
        if (availability?.kind === "unavailable") throw Object.assign(conflict("未见题暂不可发放，请保留原进度并核对课程记录；没有新增活动。"),
          { reason: availability.reason, code: "SPAN_UNSEEN_UNAVAILABLE" });
        if (context.resumeSession) {
          if (availability?.kind === "available") {
            await createOpeningLearningAttemptInTx(tx, scope, { sessionId: context.resumeSession.sessionId,
              clientKey: `span-tutor-issue:${input.operationId}`, spanExercise: { sourceId: context.sourceIds[0]!,
                problemId: availability.problem.id, version: Number(availability.problem.version) } });
            await reserveSpanTutorActivityBudget(tx, scope, { courseId: context.courseId, activityId: context.resumeSession.activityId,
              minutes: context.intent.timeBudgetMinutes, expectedGrantRevision: context.grantRevision });
            context.resumeSession = (await sessions.get(scope, context.resumeSession.activityId))!;
          }
          return context.resumeSession;
        }
        if (context.originReference) {
          const origin = await readOpeningSpanTutorOrigin(db, scope, context.originReference, context.courseId, context.originSnapshotRevision);
          const ended = origin.session.status === "completed" ? origin.session : await sessions.save(scope, origin.session.activityId,
            { expectedRevision: origin.session.revision, intent: origin.session.intent, moveId: origin.session.moveId, status: "completed" });
          context.originSnapshotRevision = ended.revision;
        }
        let session = await sessions.create(scope, { courseId: context.courseId, sourceIds: context.sourceIds,
          intent: context.intent, clientKey: input.operationId, ...(context.dueRetestId ? { retestId: context.dueRetestId } : {}) });
        const mode = spanModeForIntent(context.intent);
        const explain = input.decision.activityKind === "full_explain" || input.decision.activityKind === "targeted_explain";
        const moveId = context.dueRetestId || !explain ? `${mode}-reserved` as const
          : mode === "overview" ? "overview-links" : mode === "challenge" ? "challenge-predict" : "self-example";
        if (session.moveId !== moveId && session.status !== "completed") session = await sessions.save(scope, session.activityId,
          { expectedRevision: session.revision, intent: session.intent, moveId, status: session.status });
        if (availability?.kind === "available") await createOpeningLearningAttemptInTx(tx, scope, { sessionId: session.sessionId,
          clientKey: `span-tutor-issue:${input.operationId}`, spanExercise: { sourceId: context.sourceIds[0]!,
            problemId: availability.problem.id, version: Number(availability.problem.version) } });
        await reserveSpanTutorActivityBudget(tx, scope, { courseId: context.courseId, activityId: session.activityId,
          minutes: context.intent.timeBudgetMinutes, expectedGrantRevision: context.grantRevision });
        await tx`UPDATE opening_teaching_activities SET goal_json=goal_json || ${tx.json({ tutorNextAction: {
          operationId: input.operationId, decision: input.decision, observationIds: context.decisionInput.observations.map(row => row.id), sourceRefs: context.sourceRefs, grantRevision: context.grantRevision,
          ...(context.originReference ? { originReference: context.originReference } : {}) } })}::jsonb
          WHERE id=${session.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        context.resumeSession = (await sessions.get(scope, session.activityId))!;
        return context.resumeSession;
      }) as Promise<SpanLessonSnapshot>;
    },
  };
}
