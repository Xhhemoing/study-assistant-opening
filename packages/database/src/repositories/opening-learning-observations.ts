import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import type { LearningObservation, ObservationInput, Scope } from "@aistudy/contracts";
import { assertRetestSubmitEarliestAllowed, evaluateEvidenceEligibility, resolveAssistance } from "@aistudy/domain";
import { admitLearningSources, learningError, learningIso, lockLearningHistory, lockLearningSession, lockWorkspaceLearningHistory, mapLearningObservation, nextLearningHistoryRevision, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContext } from "./opening-learning-evidence-context";
import { refreshOpeningLearningEligibility } from "./opening-learning-eligibility";
import { transitionRetestActivityForTask } from "./opening-retest-activities";
import { linkOpeningSkillEvidenceInTx } from "./opening-skill-evidence";
import { evaluateOpeningMatrixAttempt } from "./opening-matrix-evaluation";
import { evaluateOpeningExamAttempt } from "./opening-exam-integration-evaluation";

export async function insertOpeningLearningObservation(sql: Sql, scope: Scope, input: ObservationInput,
  opts: { verdictSource?: LearningObservation["verdictSource"]; referenceSourceId?: string | null; sourceTurnIds?: string[]; revisesObservationId?: string | null; examSprintPublication?: true; requirementKey?: string; capturedSourceVersions?: Record<string, number> } = {}) {
  return sql.begin(tx => insertOpeningLearningObservationInTx(tx, scope, input, opts));
}

/** Caller owns the transaction, so review scheduling and learning evidence commit together. */
export async function insertOpeningLearningObservationInTx(tx: TransactionSql, scope: Scope, input: ObservationInput,
  opts: { verdictSource?: LearningObservation["verdictSource"]; referenceSourceId?: string | null; sourceTurnIds?: string[]; revisesObservationId?: string | null; examSprintPublication?: true; requirementKey?: string; capturedSourceVersions?: Record<string, number> } = {}) {
  if (opts.revisesObservationId || input.revisesObservationId) throw learningError("CONFLICT", "observation revision requires the separate revision API");
  await lockWorkspaceLearningHistory(tx, scope);
  const session = await lockLearningSession(tx, scope, input.sessionId);
  if (session.course_id !== input.courseId || session.skill_label !== input.skillLabel) throw learningError("VALIDATION", "observation does not match its session course and skill");
  if (input.sourceIds.some((id) => !(session.source_ids as string[]).includes(id))) throw learningError("VALIDATION", "observation source is outside the session");
  await lockLearningHistory(tx, scope, input.courseId);
  const sources = await admitLearningSources(tx, scope, input.sourceIds);
  const verdictSource = opts.verdictSource ?? input.verdictSource ?? "self_report";
  const referenceSourceId = opts.referenceSourceId ?? input.referenceSourceId ?? input.referenceCheck?.referenceSourceId ?? null;
  if (input.referenceCheck && verdictSource !== "reference_checked") throw learningError("VALIDATION", "reference check requires an explicit reference_checked verdict");
  if (verdictSource === "reference_checked") {
    if (!referenceSourceId || !(session.source_ids as string[]).includes(referenceSourceId)) throw learningError("VALIDATION", "reference source is not bound to this session");
    if (input.referenceCheck && input.referenceCheck.referenceSourceId !== referenceSourceId) throw learningError("VALIDATION", "reference check source mismatch");
    await admitLearningSources(tx, scope, [referenceSourceId]);
  }
  const attemptRows = input.attemptId ? await tx`SELECT * FROM opening_learning_attempts WHERE id=${input.attemptId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE` : [];
  const attempt = attemptRows[0];
  if (input.attemptId && (!attempt || attempt.session_id !== input.sessionId || attempt.course_id !== input.courseId)) throw learningError("VALIDATION", "attempt is outside this session");
  if (attempt && input.problemId && input.problemId !== attempt.problem_id) throw learningError("VALIDATION", "attempt problem mismatch");
  const attemptSources = attempt ? await admitLearningSources(tx, scope, attempt.source_ids as string[]) : sources;
  const retestActivities = input.retestId ? await tx`SELECT id, candidate_id, course_id, skill_label, requirement_key, task_id, status,
    not_before_at, recommended_at, scheduled_start_at
    FROM opening_retest_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND (candidate_id=${input.retestId} OR id=${input.retestId}) FOR UPDATE` : [];
  if (input.retestId && retestActivities.length !== 1) throw learningError("VALIDATION", "retest activity is missing or ambiguous");
  const retestActivity = retestActivities[0] as Record<string, unknown> | undefined;
  if (retestActivity && (retestActivity.course_id !== input.courseId || retestActivity.skill_label !== input.skillLabel)) {
    throw learningError("VALIDATION", "retest activity does not match the observation");
  }
  if (retestActivity && attempt && retestActivity.requirement_key !== attempt.requirement_key) {
    throw learningError("VALIDATION", "retest requirement does not match the attempt");
  }
  const skillNodeId = input.nodeId ?? null;
  const skillDimension = input.dimension ?? null;
  if ((skillNodeId == null) !== (skillDimension == null)) {
    throw learningError("VALIDATION", "nodeId and dimension must be provided together for SkillEvidence");
  }
  const intent = { sessionId: input.sessionId, courseId: input.courseId, skillLabel: input.skillLabel, sourceIds: [...new Set(input.sourceIds)].sort(),
    attemptId: input.attemptId ?? null, problemId: input.problemId ?? null, retestId: (retestActivity?.id as string | undefined) ?? null,
    answer: input.answer, outcome: input.outcome, assistance: input.assistance, verdictSource, referenceSourceId,
    referenceCheck: input.referenceCheck ? { referenceSourceId: input.referenceCheck.referenceSourceId, method: input.referenceCheck.method, scope: input.referenceCheck.scope } : null,
    ...(skillNodeId && skillDimension ? { nodeId: skillNodeId, dimension: skillDimension } : {}) };
  const existing = await tx`SELECT * FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
  const linkSkillEvidence = async (observationId: string) => {
    if (!skillNodeId || !skillDimension) return;
    await linkOpeningSkillEvidenceInTx(tx, scope, {
      courseId: input.courseId,
      nodeId: skillNodeId,
      observationId,
      dimension: skillDimension,
    });
  };
  const qualify = async (record: LearningObservation) => {
    const facts = await readOpeningLearningEvidenceContext(tx, scope, record);
    const eligibility = evaluateEvidenceEligibility(facts.observation, facts.context);
    return { ...record, eligibility, allowsIndependent: eligibility.independentAttempt === "yes" && eligibility.verifiedCorrect === "yes" && eligibility.usableForCurrentVersion === "yes" };
  };
  if (existing[0]) {
    const saved = existing[0].submitted_intent as typeof intent | null;
    if (!isDeepStrictEqual(saved, intent)) throw learningError("CONFLICT", "observation clientKey payload conflict");
    await linkSkillEvidence(String(existing[0].id));
    return qualify(mapLearningObservation(existing[0]));
  }
  if (attempt?.submitted_at) throw learningError("CONFLICT", "attempt already submitted");
  const examEvaluation = await evaluateOpeningExamAttempt(tx, scope, attempt, input.answer, attemptSources, opts.examSprintPublication === true);
  const matrixEvaluation = examEvaluation ? null : await evaluateOpeningMatrixAttempt(tx, scope, attempt, input.answer, attemptSources);
  const controlledEvaluation = examEvaluation ?? (matrixEvaluation ? { ...matrixEvaluation, specVersion: "matrix-arithmetic-v1" as const } : null);
  if ((attempt?.create_intent as { teachingBlock?: unknown } | undefined)?.teachingBlock) {
    const activities = await tx`SELECT status,content_version FROM opening_teaching_activities
      WHERE id=${String(session.activity_id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!activities[0] || activities[0].status === "completed") throw learningError("CONFLICT", "completed teaching activity cannot accept an answer");
    const pinned = (attempt!.create_intent as { teachingBlock: { contentVersion: number } }).teachingBlock.contentVersion;
    if (Number(activities[0].content_version) !== pinned) throw learningError("CONFLICT", "teaching content changed before answer submission");
  }
  const nowRows = await tx`SELECT clock_timestamp() AS at`;
  const recordedAt = learningIso(nowRows[0]!.at)!;
  const submittedAt = examEvaluation?.capturedSubmittedAt ?? recordedAt;
  // DL11: authoritative earliest-allowed gate for any retest-linked observation submit
  // (attempt submit and direct observation POST). Idempotent clientKey hits return above.
  if (retestActivity) {
    assertRetestSubmitEarliestAllowed({
      notBeforeAt: learningIso(retestActivity.not_before_at),
      recommendedAt: learningIso(retestActivity.recommended_at),
      scheduledStartAt: learningIso(retestActivity.scheduled_start_at),
    }, submittedAt);
  }
  const problemId = attempt ? attempt.problem_id as string | null : input.problemId ?? null;
  const itemVersionId = attempt?.item_version_id as string | null ?? null;
  const referenceCheck = !controlledEvaluation && input.referenceCheck ? { attemptId: input.attemptId ?? null, problemId, itemVersionId,
    referenceId: input.referenceCheck.referenceSourceId, method: input.referenceCheck.method, scope: input.referenceCheck.scope,
    checkerId: scope.ownerUserId, outcome: input.outcome } : null;
  const sourceVersions = attempt?.source_versions ?? opts.capturedSourceVersions ?? (input.problemId ? null : Object.fromEntries(sources.map((s) => [String(s.id), Number(s.version)])));
  const revision = await nextLearningHistoryRevision(tx, scope, input.courseId), id = randomUUID();
  const serverEvaluation = controlledEvaluation ? {
    observationId: id, attemptId: String(attempt!.id), problemId: String(problemId), itemVersionId: String(itemVersionId),
    requirementKey: String(attempt!.requirement_key), evaluatorVersion: controlledEvaluation.evaluatorVersion,
    specVersion: controlledEvaluation.specVersion, decision: controlledEvaluation.decision, outcome: controlledEvaluation.outcome,
    reasonCodes: controlledEvaluation.reasonCodes, evaluatedAt: recordedAt,
  } : null;
  const effectiveOutcome = controlledEvaluation?.outcome ?? input.outcome;
  const effectiveAssistance = matrixEvaluation?.priorFeedback ? resolveAssistance(input.assistance, ["hinted"]) : input.assistance;
  const effectiveVerdictSource = controlledEvaluation ? "deterministic" : verdictSource;
  const workspaceRevision = await nextWorkspaceLearningHistoryRevision(tx, scope);
  const activityId = String(session.activity_id);
  const rows = await tx`INSERT INTO opening_learning_observations
    (id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,source_ids,problem_id,retest_id,answer,outcome,assistance,client_key,occurred_at,
     source_turn_ids,verdict_source,reference_source_id,evidence_verdict,attempt_id,item_version_id,requirement_key,started_at,submitted_at,recorded_at,source_versions,reference_check,server_evaluation,submitted_intent,history_revision,workspace_history_revision,root_observation_id,effective_head_id,revision_kind,actor_id)
     VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${input.sessionId},${input.courseId},${activityId},${input.skillLabel},${input.sourceIds},${problemId},${(retestActivity?.id as string | undefined) ?? null},${input.answer},${effectiveOutcome},${effectiveAssistance},${input.clientKey},${submittedAt},
     ${opts.sourceTurnIds ?? []},${effectiveVerdictSource},${controlledEvaluation ? null : referenceSourceId},'MASTERY_NOT_ESTABLISHED',${input.attemptId ?? null},${itemVersionId},${attempt?.requirement_key ?? opts.requirementKey ?? null},${attempt?.started_at ?? null},${attempt ? submittedAt : null},${recordedAt},${sourceVersions ? tx.json(sourceVersions as never) : null},${referenceCheck ? tx.json(referenceCheck) : null},${serverEvaluation ? tx.json(serverEvaluation) : null},${tx.json(intent)},${revision},${workspaceRevision},${id},${id},'original',${scope.ownerUserId})
    ON CONFLICT(workspace_id,client_key) DO NOTHING RETURNING *`;
  if (!rows[0]) throw learningError("CONFLICT", "observation clientKey already used");
  if (attempt) await tx`UPDATE opening_learning_attempts SET submitted_at=${submittedAt},observation_id=${id} WHERE id=${input.attemptId!}`;
  if (input.retestId) {
    // Lock the activity before its task. Task status updates and direct
    // completion use the same order to serialize the shared decision.
    const activity = retestActivity as { task_id?: string | null; status?: string };
    if (activity?.task_id && (activity.status === "accepted" || activity.status === "in_progress")) {
      const tasks = await tx`SELECT id, status FROM opening_tasks
        WHERE id=${activity.task_id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
      await transitionRetestActivityForTask(tx, scope, activity.task_id, {
        type: "complete", at: submittedAt, result: effectiveOutcome, hasObservation: true,
      });
      if (tasks.length && (tasks[0] as { status: string }).status !== "done") {
        await tx`UPDATE opening_tasks SET status='done', version=version + 1, updated_at=now()
          WHERE id=${activity.task_id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      }
    }
  }
  await refreshOpeningLearningEligibility(tx, scope, [id]);
  await linkSkillEvidence(id);
  // Ordinary observations enqueue a delayed-retest scan in the same transaction.
  // Retest completions must not scan again (avoid immediate re-proposal).
  if (!input.retestId) {
    const jobId = randomUUID();
    const scanKey = `retest-scan:${input.courseId}:${id}`;
    const [workspace] = await tx`SELECT privacy_epoch FROM workspaces
      WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    const privacyEpoch = Number((workspace as { privacy_epoch?: number } | undefined)?.privacy_epoch ?? 0);
    const inserted = await tx`
      INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, privacy_epoch)
      VALUES (
        ${jobId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${scanKey}, ${"retest"},
        ${tx.json({ courseId: input.courseId, observationId: id } as never)},
        ${privacyEpoch}
      )
      ON CONFLICT (workspace_id, key) DO NOTHING
      RETURNING id`;
    if (inserted.length) {
      await tx`
        INSERT INTO opening_outbox (workspace_id, job_id, topic, payload)
        VALUES (
          ${scope.workspaceId}, ${jobId}, ${"opening.job.enqueue"},
          ${tx.json({ jobId, kind: "retest", courseId: input.courseId, observationId: id } as never)}
        )`;
    }
  }
  return qualify(mapLearningObservation(rows[0]));
}


/** Latest observation head per problemId for an activity (V2-14 open-problem derive). */
export async function listObservationHeadsByActivity(
  sql: import("postgres").Sql,
  scope: import("@aistudy/contracts").Scope,
  activityId: string,
  limit = 100,
): Promise<
  Array<{
    problemId: string;
    itemVersionId: string | null;
    outcome: "correct" | "incorrect" | "unverified";
  }>
> {
  const capped = Math.min(Math.max(1, limit), 100);
  const rows = await sql`
    SELECT DISTINCT ON (o.problem_id)
      o.problem_id,
      o.item_version_id,
      o.outcome
    FROM opening_learning_observations o
    JOIN workspaces w ON w.id = o.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
    WHERE o.workspace_id = ${scope.workspaceId}
      AND o.owner_user_id = ${scope.ownerUserId}
      AND o.activity_id = ${activityId}
      AND o.problem_id IS NOT NULL
      AND (
        o.effective_head_id IS NOT DISTINCT FROM o.id
        OR (o.effective_head_id IS NULL AND o.root_observation_id IS NULL)
      )
    ORDER BY o.problem_id, o.occurred_at DESC, o.id DESC
    LIMIT ${capped}`;
  const out: Array<{
    problemId: string;
    itemVersionId: string | null;
    outcome: "correct" | "incorrect" | "unverified";
  }> = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const outcome = r.outcome;
    if (outcome !== "correct" && outcome !== "incorrect" && outcome !== "unverified") continue;
    out.push({
      problemId: String(r.problem_id),
      itemVersionId: (r.item_version_id ?? null) as string | null,
      outcome,
    });
  }
  return out;
}
