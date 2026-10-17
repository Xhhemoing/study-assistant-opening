import { randomUUID } from "node:crypto";
import type { LearningAttempt } from "@aistudy/contracts";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import type { OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

export const matrixSkill = "矩阵维数";
export const matrixRequirement = "matrix:matrix-arithmetic-v1:dimensions";

/** Consumer positives use the real server evaluator, never learner-asserted authority. */
export async function matrixAttemptFixture(fixture: OpeningFixture) {
  const base = await learningAttemptFixture(fixture);
  const session = await base.learning.createSession(fixture.scope, {
    courseId: base.courseId, sourceIds: [base.sourceId], skillLabel: matrixSkill,
  });
  const service = createOpeningAttemptService(fixture.sql);
  let nextVariant = 0;
  const start = (extra: Record<string, unknown> = {}) => {
    const { variant = nextVariant++ % 9, ...input } = extra;
    return service.create(fixture.scope, { sessionId: session.id, clientKey: randomUUID(),
      matrixExercise: { sourceId: base.sourceId, exerciseKey: "dimensions", variant }, ...input });
  };
  const submit = (attempt: LearningAttempt, extra: Record<string, unknown> = {}) => service.submit(fixture.scope, attempt.id, {
    clientKey: randomUUID(), answer: "[2,3]", outcome: "unverified", assistance: "independent", verdictSource: "self_report", ...extra,
  });
  const help = async (attempt: LearningAttempt, level: "hinted" | "revealed" = "hinted") => {
    const rows = backupRows(fixture.sql, fixture.scope);
    const conversation = await rows.conversation(), turnId = await rows.turn(conversation, [base.sourceId]);
    await fixture.sql`UPDATE opening_turns SET learning_session_id=${session.id},attempt_id=${attempt.id} WHERE id=${turnId}`;
    return base.learning.insertHelpExposure(fixture.scope, { id: randomUUID(), attemptId: attempt.id, sessionId: session.id,
      problemId: attempt.problemId, turnId, kind: level === "revealed" ? "solution" : "hint", level, delivered: true });
  };
  return { ...base, sessionId: session.id, start, submit, help };
}
