import { refreshOpeningLearningEligibility } from "./opening-learning-eligibility";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql } from "postgres";
import { observationRevisionInputSchema, type LearningObservation, type ObservationRevisionInput, type ObservationRevisionResult, type Scope } from "@aistudy/contracts";
import { admitLearningSources, learningError, lockLearningHistory, lockLearningOwner, lockLearningSession, lockWorkspaceLearningHistory, nextLearningHistoryRevision, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { qualifyObservationRevision } from "./opening-observation-revision-history";
import { reconcileOpeningRetestEvidence } from "./opening-retests";
export { readOpeningObservationHistory } from "./opening-observation-revision-history";

/** Workspace watermark → owner/privacy → sorted course watermarks → root → candidates. */
export async function reviseOpeningLearningObservation(sql: Sql, scope: Scope, raw: ObservationRevisionInput): Promise<ObservationRevisionResult> {
  const input = observationRevisionInputSchema.parse(raw);
  const intent = JSON.parse(JSON.stringify(input)) as ObservationRevisionInput;
  return sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, scope);
    await lockLearningOwner(tx, scope);
    const initial = await tx`SELECT root.*,head.course_id AS head_course_id FROM opening_learning_observations root
      JOIN opening_learning_observations head ON head.id=COALESCE(root.effective_head_id,root.id)
        AND head.workspace_id=root.workspace_id AND head.owner_user_id=root.owner_user_id
      WHERE root.id=${input.rootObservationId} AND COALESCE(root.root_observation_id,root.id)=root.id
        AND root.workspace_id=${scope.workspaceId} AND root.owner_user_id=${scope.ownerUserId}`;
    const preview = initial[0];
    if (!preview) throw learningError("NOT_FOUND", "observation root not found");
    const replacement = input.revisionKind === "replace" ? input.replacement : null;
    const courseIds = [...new Set([String(preview.course_id), String(preview.head_course_id), replacement?.courseId ?? String(preview.head_course_id)])].sort();
    for (const courseId of courseIds) await lockLearningHistory(tx, scope, courseId);
    const roots = await tx`SELECT * FROM opening_learning_observations WHERE id=${input.rootObservationId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    const root = roots[0];
    if (!root) throw learningError("NOT_FOUND", "observation root not found");
    // Keys are workspace/owner scoped, never scoped by attribution which a later correction may change.
    const replay = await tx`SELECT * FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
    const result = async (row: Record<string, unknown>, disposition: "applied" | "replayed"): Promise<ObservationRevisionResult> => {
      const observation = await qualifyObservationRevision(tx, scope, row);
      return { disposition, rootObservationId: input.rootObservationId, headObservationId: String(row.id), revisionKind: input.revisionKind,
        observation: input.revisionKind === "retract" ? null : observation, historyRevision: Number(row.history_revision) };
    };
    if (replay[0]) {
      if (!isDeepStrictEqual(replay[0].submitted_intent, intent)) throw learningError("CONFLICT", "revision clientKey payload conflict");
      return result(replay[0], "replayed");
    }
    const headId = String(root.effective_head_id ?? root.id);
    if (headId !== input.expectedHead || headId !== input.revisesObservationId) throw learningError("CONFLICT", "observation head changed");
    const [head] = await tx`SELECT * FROM opening_learning_observations WHERE id=${headId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND COALESCE(root_observation_id,id)=${root.id}`;
    if (!head || !courseIds.includes(String(head.course_id))) throw learningError("CONFLICT", "observation attribution changed");
    const previous = await qualifyObservationRevision(tx, scope, head);
    const session = await lockLearningSession(tx, scope, String(root.session_id));
    const courseId = replacement?.courseId ?? previous.courseId;
    const ownedCourses = await tx`SELECT id FROM courses WHERE workspace_id=${scope.workspaceId} AND id IN ${tx(courseIds)} AND archived_at IS NULL ORDER BY id FOR SHARE`;
    if (ownedCourses.length !== courseIds.length) throw learningError("NOT_FOUND", "observation course unavailable");
    const attemptRows = root.attempt_id ? await tx`SELECT session_id,course_id FROM opening_learning_attempts
      WHERE id=${root.attempt_id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE` : [];
    if (root.attempt_id && (!attemptRows[0] || attemptRows[0].session_id !== root.session_id || attemptRows[0].course_id !== session.course_id)) {
      throw learningError("VALIDATION", "observation attempt is outside its original session");
    }
    const editedAnswer = replacement && (replacement.answer !== previous.answer || replacement.outcome !== previous.outcome);
    const keepCheck = !editedAnswer && replacement?.referenceCheck === undefined
      && (replacement?.verdictSource === undefined || replacement.verdictSource === previous.verdictSource)
      && (replacement?.referenceSourceId === undefined || replacement.referenceSourceId === previous.referenceSourceId);
    const verdictSource = replacement?.verdictSource ?? (replacement?.referenceCheck ? "reference_checked" : keepCheck ? previous.verdictSource : "self_report");
    const referenceSourceId = replacement?.referenceSourceId !== undefined ? replacement.referenceSourceId
      : replacement?.referenceCheck?.referenceSourceId ?? (keepCheck ? previous.referenceSourceId : null);
    if (replacement?.referenceCheck && (verdictSource !== "reference_checked" || referenceSourceId !== replacement.referenceCheck.referenceSourceId)) throw learningError("VALIDATION", "reference check source or verdict mismatch");
    if (verdictSource === "reference_checked" && (!referenceSourceId || !(session.source_ids as string[]).includes(referenceSourceId))) throw learningError("VALIDATION", "reference source is outside original session");
    const originalSources = [...new Set([...previous.sourceIds, ...Object.keys(previous.sourceVersions ?? {}),
      ...[referenceSourceId, previous.referenceSourceId, previous.referenceCheck?.referenceId].filter((id): id is string => Boolean(id))])];
    await admitLearningSources(tx, scope, originalSources);
    const referenceCheck = replacement?.referenceCheck ? { attemptId: previous.attemptId ?? null, problemId: previous.problemId ?? null,
      itemVersionId: previous.itemVersionId ?? null, referenceId: replacement.referenceCheck.referenceSourceId, method: replacement.referenceCheck.method,
      scope: replacement.referenceCheck.scope, checkerId: scope.ownerUserId, outcome: replacement.outcome } : keepCheck ? previous.referenceCheck ?? null : null;
    const revisions = new Map<string, number>();
    for (const id of courseIds) revisions.set(id, await nextLearningHistoryRevision(tx, scope, id));
    const revision = revisions.get(courseId)!, id = randomUUID();
    const workspaceRevision = await nextWorkspaceLearningHistoryRevision(tx, scope);
    const skillLabel = replacement?.skillLabel ?? previous.skillLabel;
    const requirementKey = replacement?.requirementKey !== undefined ? replacement.requirementKey : previous.requirementKey ?? null;
    const [record] = await tx`INSERT INTO opening_learning_observations
      (id,workspace_id,owner_user_id,session_id,course_id,skill_label,source_ids,problem_id,retest_id,answer,outcome,assistance,client_key,occurred_at,
       source_turn_ids,verdict_source,reference_source_id,evidence_verdict,attempt_id,item_version_id,requirement_key,started_at,submitted_at,recorded_at,source_versions,reference_check,submitted_intent,history_revision,workspace_history_revision,
       root_observation_id,revises_observation_id,revision_kind,revision_reason,actor_id)
      VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${head.session_id},${courseId},${skillLabel},${head.source_ids},${head.problem_id},${head.retest_id},
       ${replacement?.answer ?? previous.answer},${replacement?.outcome ?? previous.outcome},${replacement?.assistance ?? previous.assistance},${input.clientKey},${head.occurred_at},
       ${head.source_turn_ids},${verdictSource},${referenceSourceId},'MASTERY_NOT_ESTABLISHED',${head.attempt_id},${head.item_version_id},${requirementKey},${head.started_at},${head.submitted_at},clock_timestamp(),
       ${head.source_versions ? tx.json(head.source_versions) : null},${referenceCheck ? tx.json(referenceCheck) : null},${tx.json(intent)},${revision},${workspaceRevision},
       ${root.id},${headId},${input.revisionKind},${input.reason},${scope.ownerUserId})
      ON CONFLICT(workspace_id,client_key) DO NOTHING RETURNING *`;
    if (!record) throw learningError("CONFLICT", "revision clientKey already used");
    await tx`UPDATE opening_learning_observations SET effective_head_id=${id} WHERE id=${root.id}`;
    const identity = (observation: Pick<LearningObservation, "courseId" | "requirementKey" | "skillLabel">) => ({ courseId: observation.courseId, requirementKey: observation.requirementKey ?? null, skillLabel: observation.skillLabel });
    await reconcileOpeningRetestEvidence(tx, scope, { rootObservationId: String(root.id), previousHeadObservationId: headId, headObservationId: id,
      previousIdentity: identity(previous), currentIdentity: input.revisionKind === "retract" ? null : identity({ courseId, requirementKey, skillLabel }), historyRevision: revision });
    await refreshOpeningLearningEligibility(tx, scope, [String(root.id)]);
    return result(record, "applied");
  }) as Promise<ObservationRevisionResult>;
}
