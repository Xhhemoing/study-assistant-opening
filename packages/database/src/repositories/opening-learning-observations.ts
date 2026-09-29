import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
import type { LearningObservation, ObservationInput, Scope } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { admitLearningSources, learningError, learningIso, lockLearningHistory, lockLearningSession, mapLearningObservation, nextLearningHistoryRevision } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContext } from "./opening-learning-evidence-context";
import { transitionRetestActivityForTask } from "./opening-retest-activities";

export async function insertOpeningLearningObservation(sql: Sql, scope: Scope, input: ObservationInput,
  opts: { verdictSource?: LearningObservation["verdictSource"]; referenceSourceId?: string | null; sourceTurnIds?: string[]; revisesObservationId?: string | null } = {}) {
  if (opts.revisesObservationId || input.revisesObservationId) throw learningError("CONFLICT", "observation revision requires the separate revision API");
  return sql.begin(async (tx) => {
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
    if (attempt) await admitLearningSources(tx, scope, attempt.source_ids as string[]);
    const retestActivities = input.retestId ? await tx`SELECT id, candidate_id, course_id, skill_label, requirement_key, task_id, status
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
    const intent = { sessionId: input.sessionId, courseId: input.courseId, skillLabel: input.skillLabel, sourceIds: [...new Set(input.sourceIds)].sort(),
      attemptId: input.attemptId ?? null, problemId: input.problemId ?? null, retestId: (retestActivity?.id as string | undefined) ?? null,
      answer: input.answer, outcome: input.outcome, assistance: input.assistance, verdictSource, referenceSourceId,
      referenceCheck: input.referenceCheck ? { referenceSourceId: input.referenceCheck.referenceSourceId, method: input.referenceCheck.method, scope: input.referenceCheck.scope } : null };
    const existing = await tx`SELECT * FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
    const qualify = async (record: LearningObservation) => {
      const facts = await readOpeningLearningEvidenceContext(tx, scope, record);
      const eligibility = evaluateEvidenceEligibility(facts.observation, facts.context);
      return { ...record, eligibility, allowsIndependent: eligibility.independentAttempt === "yes" && eligibility.verifiedCorrect === "yes" && eligibility.usableForCurrentVersion === "yes" };
    };
    if (existing[0]) {
      const saved = existing[0].submitted_intent as typeof intent | null;
      if (!isDeepStrictEqual(saved, intent)) throw learningError("CONFLICT", "observation clientKey payload conflict");
      return qualify(mapLearningObservation(existing[0]));
    }
    if (attempt?.submitted_at) throw learningError("CONFLICT", "attempt already submitted");
    const nowRows = await tx`SELECT clock_timestamp() AS at`;
    const submittedAt = learningIso(nowRows[0]!.at)!;
    const problemId = attempt ? attempt.problem_id as string | null : input.problemId ?? null;
    const itemVersionId = attempt?.item_version_id as string | null ?? null;
    const referenceCheck = input.referenceCheck ? { attemptId: input.attemptId ?? null, problemId, itemVersionId,
      referenceId: input.referenceCheck.referenceSourceId, method: input.referenceCheck.method, scope: input.referenceCheck.scope,
      checkerId: scope.ownerUserId, outcome: input.outcome } : null;
    const sourceVersions = attempt?.source_versions ?? (input.problemId ? null : Object.fromEntries(sources.map((s) => [String(s.id), Number(s.version)])));
    const revision = await nextLearningHistoryRevision(tx, scope, input.courseId), id = randomUUID();
    const rows = await tx`INSERT INTO opening_learning_observations
      (id,workspace_id,owner_user_id,session_id,course_id,skill_label,source_ids,problem_id,retest_id,answer,outcome,assistance,client_key,occurred_at,
       source_turn_ids,verdict_source,reference_source_id,evidence_verdict,attempt_id,item_version_id,requirement_key,started_at,submitted_at,recorded_at,source_versions,reference_check,submitted_intent,history_revision,root_observation_id,effective_head_id,revision_kind,actor_id)
       VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${input.sessionId},${input.courseId},${input.skillLabel},${input.sourceIds},${problemId},${(retestActivity?.id as string | undefined) ?? null},${input.answer},${input.outcome},${input.assistance},${input.clientKey},${submittedAt},
       ${opts.sourceTurnIds ?? []},${verdictSource},${referenceSourceId},'MASTERY_NOT_ESTABLISHED',${input.attemptId ?? null},${itemVersionId},${attempt?.requirement_key ?? null},${attempt?.started_at ?? null},${attempt ? submittedAt : null},${submittedAt},${sourceVersions ? tx.json(sourceVersions as never) : null},${referenceCheck ? tx.json(referenceCheck) : null},${tx.json(intent)},${revision},${id},${id},'original',${scope.ownerUserId})
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
          type: "complete", at: submittedAt, result: input.outcome, hasObservation: true,
        });
        if (tasks.length && (tasks[0] as { status: string }).status !== "done") {
          await tx`UPDATE opening_tasks SET status='done', version=version + 1, updated_at=now()
            WHERE id=${activity.task_id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        }
      }
    }
    return qualify(mapLearningObservation(rows[0]));
  });
}
