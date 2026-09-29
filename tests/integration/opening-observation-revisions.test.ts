import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { observationRevisionInputSchema } from "@aistudy/contracts";
import { reviseOpeningLearningObservation, readOpeningObservationHistory } from "../../packages/database/src/repositories/opening-observation-revisions";
import { readOpeningCourseEvidence } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });
const replace = (id: string, extra: Record<string, unknown> = {}) => observationRevisionInputSchema.parse(JSON.parse(JSON.stringify({ rootObservationId: id, revisesObservationId: id, expectedHead: id,
  revisionKind: "replace", reason: "Correct answer", clientKey: randomUUID(), replacement: { answer: "2", outcome: "incorrect", assistance: "independent" }, ...extra })));
const revise = (input: ReturnType<typeof replace>) => reviseOpeningLearningObservation(fixture.sql, fixture.scope, input);

it("appends replacement and tombstone without overwriting captured facts, then restores the same root", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start(), original = await f.submit(attempt);
  const [before] = await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${original.id}`;
  const result = await revise(replace(original.id));
  expect(result.disposition).toBe("applied");
  expect(result.observation).toMatchObject({ rootObservationId: original.id, revisesObservationId: original.id, actorId: fixture.scope.ownerUserId,
    attemptId: attempt.id, sourceVersions: original.sourceVersions, startedAt: original.startedAt, submittedAt: original.submittedAt, occurredAt: original.occurredAt, answer: "2" });
  const [after] = await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${original.id}`;
  expect({ ...after, effective_head_id: before?.effective_head_id }).toEqual(before);
  const retract = await revise(replace(original.id, { expectedHead: result.headObservationId, revisesObservationId: result.headObservationId, revisionKind: "retract", replacement: undefined }));
  expect(retract.observation).toBeNull();
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations).toHaveLength(0);
  const history = await readOpeningObservationHistory(fixture.sql, fixture.scope, result.headObservationId);
  expect(history.revisions.map(row => row.revisionKind)).toEqual(["original", "replace", "retract"]);
  const restored = await revise(replace(original.id, { expectedHead: retract.headObservationId, revisesObservationId: retract.headObservationId }));
  expect(restored.rootObservationId).toBe(original.id);
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations.map(row => row.id)).toEqual([restored.headObservationId]);
});
it("replays lost responses before checking a stale head and rejects changed intent or roots", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start()), input = replace(original.id);
  const first = await revise(input);
  await revise(replace(original.id, { expectedHead: first.headObservationId, revisesObservationId: first.headObservationId }));
  expect(await revise(input)).toMatchObject({ ...first, disposition: "replayed" });
  await expect(revise({ ...input, reason: "Different intent" })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(revise(replace(original.id))).rejects.toMatchObject({ code: "CONFLICT" });
  const unrelated = await f.submit(await f.start());
  await expect(revise(replace(unrelated.id, { revisesObservationId: first.headObservationId }))).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(reviseOpeningLearningObservation(fixture.sql, fixture.otherScope, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(readOpeningObservationHistory(fixture.sql, fixture.otherScope, first.headObservationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("serializes concurrent head edits and same-key response replays", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  const writes = await Promise.allSettled([revise(replace(original.id)), revise(replace(original.id))]);
  expect(writes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(writes.filter(r => r.status === "rejected")).toHaveLength(1);
  const another = await f.submit(await f.start()), input = replace(another.id);
  const results = await Promise.all([revise(input), revise(input)]);
  expect(new Set(results.map(r => r.headObservationId)).size).toBe(1);
  expect(results.map(r => r.disposition).sort()).toEqual(["applied", "replayed"]);
});
it("moves attribution in one root, advances both courses, retains original help and replays after another move", async () => {
  const f = await learningAttemptFixture(fixture), destination = await learningAttemptFixture(fixture), attempt = await f.start();
  await f.help(attempt); const original = await f.submit(attempt);
  const input = replace(original.id, { replacement: { answer: "1", outcome: "correct", assistance: "independent", courseId: destination.courseId, skillLabel: "new label", requirementKey: "req-b" } });
  const changed = await revise(input);
  expect(changed.observation).toMatchObject({ courseId: destination.courseId, requirementKey: "req-b", eligibility: { independentAttempt: "no" } });
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, f.courseId)).observations).toHaveLength(0);
  expect((await readOpeningCourseEvidence(fixture.sql, fixture.scope, destination.courseId)).observations.map(r => r.id)).toEqual([changed.headObservationId]);
  expect(await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`).toMatchObject([{ revision: String(original.historyRevision! + 1) }]);
  expect(await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${destination.courseId}`).toMatchObject([{ revision: "1" }]);
  await revise(replace(original.id, { expectedHead: changed.headObservationId, revisesObservationId: changed.headObservationId, replacement: { answer: "3", outcome: "unverified", assistance: "independent", courseId: f.courseId } }));
  expect((await revise(input)).headObservationId).toBe(changed.headObservationId);
});
it("does not inherit correctness verification for an edited answer; explicit new checking remains server attributed", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start(), { verdictSource: "reference_checked", referenceSourceId: f.sourceId,
    referenceCheck: { referenceSourceId: f.sourceId, method: "Compare every step", scope: "whole_answer" } });
  const first = await revise(replace(original.id, { replacement: { answer: "changed", outcome: "correct", assistance: "independent" } }));
  expect(first.observation?.referenceCheck).toBeNull(); expect(first.observation?.eligibility?.verifiedCorrect).toBe("unknown");
  const checked = await revise(replace(original.id, { expectedHead: first.headObservationId, revisesObservationId: first.headObservationId,
    replacement: { answer: "changed", outcome: "correct", assistance: "independent", verdictSource: "reference_checked", referenceSourceId: f.sourceId,
      referenceCheck: { referenceSourceId: f.sourceId, method: "Compare corrected answer to reference", scope: "whole_answer" } } }));
  expect(checked.observation?.referenceCheck?.checkerId).toBe(fixture.scope.ownerUserId);
  expect(checked.observation?.eligibility?.verifiedCorrect).toBe("yes");
});
it("rejects excluded evidence and another owner's course even on correction", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start()), foreign = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${foreign},${fixture.otherScope.workspaceId},'Other',${foreign})`;
  await expect(revise(replace(original.id, { replacement: { answer: "2", outcome: "incorrect", assistance: "independent", courseId: foreign } }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${f.sourceId})`;
  await expect(revise(replace(original.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(readOpeningObservationHistory(fixture.sql, fixture.scope, original.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
});


it("serializes opposite cross-course corrections with a fixed lock order and preserves distinct roots", async () => {
  const a = await learningAttemptFixture(fixture), b = await learningAttemptFixture(fixture);
  const first = await a.submit(await a.start()), second = await b.submit(await b.start());
  const [toB,toA] = await Promise.all([
    revise(replace(first.id, { replacement: { answer: "2", outcome: "incorrect", assistance: "independent", courseId: b.courseId, requirementKey: "b" } })),
    revise(replace(second.id, { replacement: { answer: "3", outcome: "incorrect", assistance: "independent", courseId: a.courseId, requirementKey: "a" } })),
  ]);
  expect(toB.rootObservationId).toBe(first.id); expect(toA.rootObservationId).toBe(second.id);
  expect((await readOpeningCourseEvidence(fixture.sql,fixture.scope,a.courseId)).observations.map(row => row.id)).toEqual([toA.headObservationId]);
  expect((await readOpeningCourseEvidence(fixture.sql,fixture.scope,b.courseId)).observations.map(row => row.id)).toEqual([toB.headObservationId]);
  expect(await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id IN (${a.courseId},${b.courseId})`).toMatchObject([{revision:"4"},{revision:"4"}]);
});
it("revises a restored legacy row with absent root/head metadata", async () => {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start());
  await fixture.sql`UPDATE opening_learning_observations SET root_observation_id=NULL,effective_head_id=NULL,revision_kind=NULL,actor_id=NULL WHERE id=${original.id}`;
  const result = await revise(replace(original.id));
  expect((await readOpeningObservationHistory(fixture.sql,fixture.scope,original.id)).revisions.map(row => row.id)).toEqual([original.id,result.headObservationId]);
  expect((await readOpeningCourseEvidence(fixture.sql,fixture.scope,f.courseId)).observations.map(row => row.id)).toEqual([result.headObservationId]);
});

it("preserves a documented check when equal verdict/reference values are explicitly resubmitted", async () => {
  const f=await learningAttemptFixture(fixture), original=await f.submit(await f.start(),{ verdictSource:"reference_checked",referenceSourceId:f.sourceId,
    referenceCheck:{referenceSourceId:f.sourceId,method:"Checked every line",scope:"whole_answer"} });
  expect(original.eligibility.verifiedCorrect).toBe("yes");
  const corrected=await revise(replace(original.id,{replacement:{answer:original.answer,outcome:original.outcome,assistance:original.assistance,
    verdictSource:original.verdictSource,referenceSourceId:original.referenceSourceId,skillLabel:"More precise label"}}));
  expect(corrected.observation?.referenceCheck).toEqual(original.referenceCheck);
  expect(corrected.observation?.eligibility?.verifiedCorrect).toBe("yes");
  const changed=await revise(replace(original.id,{revisesObservationId:corrected.headObservationId,expectedHead:corrected.headObservationId,
    replacement:{answer:"a different answer",outcome:original.outcome,assistance:original.assistance,verdictSource:original.verdictSource,referenceSourceId:original.referenceSourceId}}));
  expect(changed.observation?.referenceCheck).toBeNull();expect(changed.observation?.eligibility?.verifiedCorrect).toBe("unknown");
});
