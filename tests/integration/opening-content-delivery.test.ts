import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createLibraryRepository, createOpeningContentDeliveryRepository } from "@aistudy/database";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { readOpeningLearningEvidenceContext } from "../../packages/database/src/repositories/opening-learning-evidence-context";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
async function note() {
  return createLibraryRepository(fixture.sql).createDocument({ workspaceId: fixture.scope.workspaceId, title: "Personal note", lifecycle: "scratch", blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "A note with unknown mathematical association" } }] });
}
it("generic note release only narrows already-open attempts, and replay never adds future attempts", async () => {
  const f = await learningAttemptFixture(fixture);
  const earlier = await f.start();
  const earlierAnswer = await f.submit(earlier);
  const open = await f.start({ problemId: earlier.problemId, problem: undefined });
  const document = await note();
  const delivery = createOpeningContentDeliveryRepository(fixture.sql), key = randomUUID();
  const receipts = await delivery.note(fixture.scope, key, document);
  expect(receipts).toHaveLength(2);
  const [target] = await fixture.sql`SELECT attempt_id,release_intent FROM opening_help_exposures
    WHERE workspace_id=${fixture.scope.workspaceId} AND attempt_id=${open.id}`;
  expect(target!.release_intent.originReference.possibleOpenAttemptOnly).toBe(true);
  const answer = await f.submit(open);
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(evidence.observation, evidence.context)).toMatchObject({ independentAttempt: "unknown", reasonCodes: expect.arrayContaining(["help_association_unknown"]) });
  const previous = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, earlierAnswer);
  expect(evaluateEvidenceEligibility(previous.observation, previous.context).independentAttempt).toBe("yes");
  const future = await f.start({ problemId: open.problemId, problem: undefined });
  expect((await delivery.note(fixture.scope, key, document)).map(row => row.id).sort()).toEqual(receipts.map(row => row.id).sort());
  const futureAnswer = await f.submit(future);
  const futureEvidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, futureAnswer);
  expect(evaluateEvidenceEligibility(futureEvidence.observation, futureEvidence.context).independentAttempt).toBe("yes");
});
it("generic note release does not target a paused activity or a foreign document", async () => {
  const f = await learningAttemptFixture(fixture), open = await f.start(), document = await note();
  const paused = await fixture.sql`UPDATE opening_teaching_activities a SET status='paused'
    FROM opening_learning_sessions s WHERE s.id=${open.sessionId} AND s.workspace_id=${fixture.scope.workspaceId}
      AND a.id=s.activity_id AND a.workspace_id=s.workspace_id RETURNING a.id`;
  expect(paused).toHaveLength(1);
  const delivery = createOpeningContentDeliveryRepository(fixture.sql);
  const receipts = await delivery.note(fixture.scope, randomUUID(), document);
  expect(receipts).toHaveLength(1);
  const [count] = await fixture.sql`SELECT count(*)::int AS n FROM opening_help_exposures WHERE attempt_id=${open.id}`;
  expect(count!.n).toBe(0);
  await expect(delivery.note(fixture.otherScope, randomUUID(), document)).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("the material delivery wrapper preserves exact source/page scope and changes no other question", async () => {
  const f = await learningAttemptFixture(fixture), open = await f.start();
  await fixture.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES(${randomUUID()},${f.sourceId},1,2,'Unrelated content')`;
  const delivery = createOpeningContentDeliveryRepository(fixture.sql);
  await delivery.source(fixture.scope, randomUUID(), { sourceId: f.sourceId, version: 1, page: 2 });
  const answer = await f.submit(open);
  const unchanged = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, answer);
  expect(evaluateEvidenceEligibility(unchanged.observation, unchanged.context).independentAttempt).toBe("yes");
  const next = await f.start({ problemId: open.problemId, problem: undefined });
  await delivery.source(fixture.scope, randomUUID(), { sourceId: f.sourceId, version: 1, page: 1 });
  const nextAnswer = await f.submit(next);
  const narrowed = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, nextAnswer);
  expect(evaluateEvidenceEligibility(narrowed.observation, narrowed.context).independentAttempt).toBe("unknown");
});
it("an unavailable old target material does not prevent unrelated personal note delivery", async () => {
  const f = await learningAttemptFixture(fixture), open = await f.start(), document = await note();
  await fixture.sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${f.sourceId}`;
  const receipts = await createOpeningContentDeliveryRepository(fixture.sql).note(fixture.scope, randomUUID(), document);
  expect(receipts.some(receipt => receipt.contextAnchor.attemptId === open.id)).toBe(true);
});
