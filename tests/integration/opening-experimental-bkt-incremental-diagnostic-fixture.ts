import { randomUUID } from "node:crypto";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createOpeningExperimentalBktSnapshotRepository, openingExperimentalBktHeadsQuery } from "../../packages/database/src/repositories/opening-experimental-bkt-snapshot";
import { createExperimentalBktSnapshotService } from "../../apps/web/src/lib/experimental-bkt-snapshot-service";
import type { ExperimentalBktSnapshotHost, ExperimentalBktTrustedHostContext } from "../../apps/web/src/lib/experimental-bkt-snapshot-service-types";
import type { OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

// Same canonical five problems/three families as approved activation input.
// All times below are read from PG; no evidence/projection/timestamp UPDATEs.
const solutions = [
  ["span-reserved-20261021-q08", ["0", "-1/2"]],
  ["span-reserved-20261021-q02", ["-3", "1"]],
  ["span-reserved-fraction", ["1/2", "-2/3"]],
  ["span-reserved-20261021-q05", ["-1/3", "3/4"]],
  ["span-reserved-20261021-q04", ["5/2", "0"]],
] as const;
export const ruleDecision = { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null } as const;

export async function seedIncrementalDiagnostic(fixture: OpeningFixture) {
  const { sql, scope } = fixture, rows = backupRows(sql, scope);
  const sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES (${courseId},${scope.workspaceId},'Synthetic incremental diagnostic',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course',NULL)`;
  const learning = createOpeningLearningRepository(sql), attempts = createOpeningLearningAttemptRepository(sql);
  const session = await learning.createSession(scope, { courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
  const target = await attempts.create(scope, { sessionId: session.id, clientKey: randomUUID(),
    spanExercise: { sourceId, problemId: "span-example-2d", version: 1 } });
  const input = { courseId, requirementKey: SPAN_REQUIREMENT_KEY, problemId: target.problemId!, itemVersionId: target.itemVersionId!, cutoff: "" };
  const context: ExperimentalBktTrustedHostContext = { scope, target: input,
    ruleInput: { status: "observed_independent", wantsFullExplanation: false }, ruleDecision };
  // Trusted DI only. No authentication producer, request, session acceptance or browser proof.
  const host: ExperimentalBktSnapshotHost = { resolveAuthenticatedContext: async () => context,
    isCurrent: () => true, canPrepare: () => true, canCompare: () => true };
  const repository = createOpeningExperimentalBktSnapshotRepository(sql);
  const service = createExperimentalBktSnapshotService({ host, repository });
  const heads: Array<{ attempt: LearningAttempt; observation: LearningObservation }> = [];
  async function submit(index: number) {
    const [problemId, coefficients] = solutions[index]!;
    const attempt = await attempts.create(scope, { sessionId: session.id, clientKey: randomUUID(),
      spanExercise: { sourceId, problemId, version: 1 } });
    const observation = await learning.insertObservation(scope, { sessionId: session.id, courseId,
      skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId], attemptId: attempt.id, problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients,
        equation: attempt.spanExercise, coordinateChecks: attempt.spanExercise!.target }),
      outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    heads.push({ attempt, observation });
  }
  async function inspect() {
    // Let the natural clock advance beyond the last record before millisecond formatting.
    await sql`SELECT pg_sleep(0.003)`;
    const [clock] = await sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff`;
    input.cutoff = String(clock!.cutoff);
    const [counter] = await sql`SELECT revision FROM opening_workspace_history_revisions
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    const projected = await sql`SELECT head_observation_id,input_revision,independent_attempt,verified_correct,
      usable_for_current_version,reason_codes FROM opening_learning_eligibility
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} ORDER BY input_revision,head_observation_id`;
    const live = await sql.begin("isolation level repeatable read read only", tx => openingExperimentalBktHeadsQuery(tx, scope, input));
    const snapshot = await repository.read(scope, input), port = await service.readPort({ enabled: true });
    return { revision: String(counter!.revision), projected, live, snapshot, port };
  }
  async function help(sameCourse: boolean) {
    let helpSession = session;
    if (!sameCourse) {
      const otherCourse = randomUUID();
      await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${otherCourse},${scope.workspaceId},'Other diagnostic course',${otherCourse})`;
      await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
        VALUES (${scope.workspaceId},${otherCourse},'source',${sourceId},'core','course',NULL)`;
      helpSession = await learning.createSession(scope, { courseId: otherCourse, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
    }
    const attempt = await attempts.create(scope, { sessionId: helpSession.id, clientKey: randomUUID(),
      spanExercise: { sourceId, problemId: "span-example-2d", version: 1 } });
    const conversation = await rows.conversation(), turnId = await rows.turn(conversation, [sourceId]);
    await sql`UPDATE opening_turns SET learning_session_id=${helpSession.id},attempt_id=${attempt.id} WHERE id=${turnId}`;
    return learning.insertHelpExposure(scope, { id: randomUUID(), sessionId: helpSession.id, attemptId: attempt.id,
      problemId: attempt.problemId, turnId, kind: "hint", level: "hinted", delivered: true });
  }
  return { sql, scope, courseId, heads, submit, inspect, help };
}
export type IncrementalDiagnostic = Awaited<ReturnType<typeof seedIncrementalDiagnostic>>;
