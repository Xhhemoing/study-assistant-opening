import { randomUUID } from "node:crypto";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createOpeningExperimentalBktSnapshotRepository } from "../../packages/database/src/repositories/opening-experimental-bkt-snapshot";
import { refreshOpeningLearningEligibility } from "../../packages/database/src/repositories/opening-learning-eligibility";
import type { ExperimentalBktSnapshotHost, ExperimentalBktTrustedHostContext } from "../../apps/web/src/lib/experimental-bkt-snapshot-service-types";
import type { OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

// Independent handwritten solutions to existing canonical items, not fabricated
// qualification rows. Five problems span THREE non-target canonical families.
const solutions = [
  ["span-reserved-20261021-q08", ["0", "-1/2"]],
  ["span-reserved-20261021-q02", ["-3", "1"]],
  ["span-reserved-fraction", ["1/2", "-2/3"]],
  ["span-reserved-20261021-q05", ["-1/3", "3/4"]],
  ["span-reserved-20261021-q04", ["5/2", "0"]],
  ["span-reserved-20261021-q06", ["-2", "3"]],
] as const;
export const activationCutoff = "2026-11-10T12:00:00.000Z";

export async function seedFiveActivation(fixture: OpeningFixture, options: { count?: 4 | 5 | 6; olderErrors?: boolean } = {}) {
  const { sql, scope } = fixture, rows = backupRows(sql, scope);
  const sourceId = await rows.source(), courseId = randomUUID();
  await rows.chunk(sourceId);
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES (${courseId},${scope.workspaceId},'Synthetic five-problem activation',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
    VALUES (${scope.workspaceId},${courseId},'source',${sourceId},'core','course',NULL)`;
  const learning = createOpeningLearningRepository(sql), attempts = createOpeningLearningAttemptRepository(sql);
  const session = await learning.createSession(scope, { courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId] });
  const start = (catalogueId: string, selectedSource = sourceId) => attempts.create(scope, {
    sessionId: session.id, clientKey: randomUUID(), spanExercise: { sourceId: selectedSource, problemId: catalogueId, version: 1 },
  });
  const target = await start("span-example-2d");
  const heads: Array<{ attempt: LearningAttempt; observation: LearningObservation }> = [];
  async function submit(index: number, selectedSource = sourceId) {
    const [catalogueId, correct] = solutions[index]!;
    const attempt = await start(catalogueId, selectedSource);
    const coefficients = options.olderErrors && index < 4 ? ["99", "99"] : [...correct];
    // Real insertObservation invokes the real deterministic span scorer. Neither
    // outcome nor eligibility is asserted by the caller or written by raw SQL.
    const observation = await learning.insertObservation(scope, { sessionId: session.id, courseId,
      skillLabel: SPAN_SKILL_LABEL, sourceIds: [selectedSource], attemptId: attempt.id, problemId: attempt.problemId,
      clientKey: randomUUID(), answer: JSON.stringify({ membership: "in_span", coefficients,
        equation: attempt.spanExercise, coordinateChecks: attempt.spanExercise!.target }),
      outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    const head = { attempt, observation };
    heads.push(head);
    return head;
  }
  for (let index = 0; index < (options.count ?? 5); index++) await submit(index);
  async function refresh() {
    // Synthetic clocks only; qualification is recomputed by the real repository.
    await sql`UPDATE opening_learning_item_versions SET created_at='2026-11-10T08:00:00Z' WHERE course_id=${courseId}`;
    await sql`UPDATE opening_learning_attempts SET started_at='2026-11-10T09:00:00Z' WHERE course_id=${courseId}`;
    for (const [index, head] of heads.entries()) {
      const submitted = `2026-11-10T10:0${index}:00.000Z`, recorded = `2026-11-10T10:0${index}:30.000Z`;
      await sql`UPDATE opening_learning_attempts SET submitted_at=${submitted} WHERE id=${head.attempt.id}`;
      await sql`UPDATE opening_learning_observations SET started_at='2026-11-10T09:00:00Z',
        submitted_at=${submitted},recorded_at=${recorded} WHERE id=${head.observation.id}`;
    }
    await sql.begin(tx => refreshOpeningLearningEligibility(tx, scope, heads.map(h => h.observation.id)));
  }
  await refresh();
  const input = { courseId, requirementKey: SPAN_REQUIREMENT_KEY, problemId: target.problemId!,
    itemVersionId: target.itemVersionId!, cutoff: activationCutoff };
  const context: ExperimentalBktTrustedHostContext = { scope, target: input,
    ruleInput: { status: "observed_independent", wantsFullExplanation: false },
    ruleDecision: { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null } };
  // Authorized DI host fixture, NOT a concrete authentication producer or HTTP.
  const grants = { current: true, prepare: true, compare: true, resolves: 0 };
  const host: ExperimentalBktSnapshotHost = {
    async resolveAuthenticatedContext() { grants.resolves++; return context; },
    isCurrent: () => grants.current, canPrepare: () => grants.prepare, canCompare: () => grants.compare,
  };
  const repository = createOpeningExperimentalBktSnapshotRepository(sql);
  async function duplicateCanonicalProblem() {
    // A second real source yields a different DB problem UUID but the SAME
    // canonical catalogue item. The real reader must reject both copies.
    const second = await rows.source();
    await rows.chunk(second);
    await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
      VALUES (${scope.workspaceId},${courseId},'source',${second},'core','course',NULL)`;
    await sql`UPDATE opening_learning_sessions SET source_ids=ARRAY[${sourceId},${second}]::uuid[] WHERE id=${session.id}`;
    await submit(0, second);
    await refresh();
  }
  return { sql, scope, sourceId, courseId, target, heads, context, grants, host, repository, input, refresh, duplicateCanonicalProblem };
}
export type FiveActivationFixture = Awaited<ReturnType<typeof seedFiveActivation>>;
