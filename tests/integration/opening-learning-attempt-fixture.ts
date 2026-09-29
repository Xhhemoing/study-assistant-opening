import { randomUUID } from "node:crypto";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import type { LearningAttempt as Attempt } from "@aistudy/contracts";
import type { OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
export async function learningAttemptFixture(fixture: OpeningFixture) {
  const rows = backupRows(fixture.sql, fixture.scope), sourceId = await rows.source(), chunkId = await rows.chunk(sourceId), courseId = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${fixture.scope.workspaceId},'Learning attempts',${courseId})`;
  const learning = createOpeningLearningRepository(fixture.sql), attempts = createOpeningLearningAttemptRepository(fixture.sql);
  const session = await learning.createSession(fixture.scope, { courseId, skillLabel: "fractions", sourceIds: [sourceId] });
  const start = (extra = {}) => attempts.create(fixture.scope, { sessionId: session.id, clientKey: randomUUID(),
    problem: { sourceId, chunkId, physicalPage: 1, stemSnapshot: "1/2 + 1/2?", artifactKind: "reference_item" }, ...extra });
  const submit = (attempt: Attempt, extra = {}) => learning.insertObservation(fixture.scope, {
    attemptId: attempt.id, sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId], problemId: attempt.problemId,
    answer: "1", outcome: "correct", assistance: "independent", clientKey: randomUUID(), ...extra,
  });
  const help = async (attempt: Attempt, level: "hinted" | "revealed" = "hinted") => {
    const conversation = await rows.conversation(), turnId = await rows.turn(conversation, [sourceId]);
    await fixture.sql`UPDATE opening_turns SET learning_session_id=${session.id},attempt_id=${attempt.id} WHERE id=${turnId}`;
    return learning.insertHelpExposure(fixture.scope, { id: randomUUID(), attemptId: attempt.id, sessionId: session.id,
      problemId: attempt.problemId, turnId, level, delivered: true });
  };
  return { sourceId, chunkId, courseId, sessionId: session.id, learning, attempts, start, submit, help };
}
