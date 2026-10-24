import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { LearningAttempt, MaterialManifest, MaterialQuestionKey } from "@aistudy/contracts";
import { createOpeningMaterialManifestRepository, readOpeningLearningEvidenceContext } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`;
});
afterAll(async () => { await fixture?.close(); });

type Setup = Awaited<ReturnType<typeof learningAttemptFixture>>;
type Question = MaterialManifest["questions"][number];
const question: Question = { family: "fractions", number: "1", subquestion: "", page: 1, stem: "1/2 + 1/2?" };
const identity = (f: Setup, key: MaterialQuestionKey = question, sourceVersion = 1) => ({
  sourceId: f.sourceId, sourceVersion, family: key.family, number: key.number, subquestion: key.subquestion,
});
const startCanonical = (f: Setup, key: MaterialQuestionKey = question, sessionId = f.sessionId, sourceVersion = 1) =>
  f.attempts.create(fixture.scope, { sessionId, clientKey: randomUUID(), materialQuestion: identity(f, key, sourceVersion) });
const startSupplied = (f: Setup, problemId: string, sessionId = f.sessionId) =>
  f.attempts.create(fixture.scope, { sessionId, clientKey: randomUUID(), problemId });
async function classify(f: Setup, questions: Question[] = [question], sourceVersion = 1) {
  // No answers/editor reveal: only actual pre-manifest tutor help can establish
  // the exposure asserted below. Editor page receipts must not mask an ID reset.
  return createOpeningMaterialManifestRepository(fixture.sql).write(fixture.scope, f.sourceId, {
    sourceVersion, expectedRevision: 0, manifest: { role: "exercise", sections: [], questions, answers: [] },
  });
}
async function historyState(f: Setup) {
  const { sql, scope } = fixture;
  return {
    refs: [...await sql`SELECT p.* FROM opening_problem_refs p JOIN opening_learning_sessions l ON l.id=p.session_id
      WHERE p.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND l.course_id=${f.courseId} ORDER BY p.problem_id`],
    items: [...await sql`SELECT * FROM opening_learning_item_versions WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND course_id=${f.courseId} ORDER BY id`],
    attempts: [...await sql`SELECT * FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND course_id=${f.courseId} ORDER BY id`],
    courseRevision: [...await sql`SELECT revision FROM opening_learning_history_revisions
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${f.courseId}`],
    workspaceRevision: [...await sql`SELECT revision FROM opening_workspace_history_revisions
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`],
  };
}

it.each(["canonical", "supplied"] as const)("%s entry appends one canonical item while preserving old answers and real help across sessions", async entry => {
  const f = await learningAttemptFixture(fixture), { sql, scope } = fixture;
  const legacy = await f.start();
  const oldAnswer = await f.submit(legacy, { answer: "my original answer", outcome: "unverified" });
  const help = await f.help(legacy, "revealed");
  const [oldItem] = await sql`SELECT * FROM opening_learning_item_versions WHERE id=${legacy.itemVersionId!}`;
  const [oldRef] = await sql`SELECT * FROM opening_problem_refs WHERE problem_id=${legacy.problemId!}`;
  const [oldObservation] = await sql`SELECT * FROM opening_learning_observations WHERE id=${oldAnswer.id}`;
  const [oldHelp] = await sql`SELECT * FROM opening_help_exposures WHERE id=${help.id}`;
  expect(oldItem?.evaluation_spec).toBeNull();
  await classify(f);
  const session = await f.learning.createSession(scope, { courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId] });
  const reopened = entry === "canonical" ? await startCanonical(f, question, session.id) : await startSupplied(f, legacy.problemId!, session.id);
  expect(reopened.problemId).toBe(legacy.problemId);
  expect(reopened.itemVersionId).not.toBe(legacy.itemVersionId);
  expect(reopened.sourceVersions).toEqual({ [f.sourceId]: 1 });
  const [item] = await sql`SELECT * FROM opening_learning_item_versions WHERE id=${reopened.itemVersionId!}`;
  expect(item).toMatchObject({ problem_id: legacy.problemId, source_id: f.sourceId, source_version: 1,
    physical_page: 1, stem_snapshot: question.stem, evaluation_spec: { kind: "material_question", ...identity(f) } });
  // Both entry points and a new client key reuse the appended immutable version.
  const retry = await startSupplied(f, legacy.problemId!, session.id);
  const canonical = await startCanonical(f, question, session.id);
  expect(retry.itemVersionId).toBe(reopened.itemVersionId);
  expect(canonical.itemVersionId).toBe(reopened.itemVersionId);
  expect((await historyState(f)).items).toHaveLength(2);
  expect((await sql`SELECT * FROM opening_learning_item_versions WHERE id=${legacy.itemVersionId!}`)[0]).toEqual(oldItem);
  expect((await sql`SELECT * FROM opening_problem_refs WHERE problem_id=${legacy.problemId!}`)[0]).toEqual(oldRef);
  expect((await sql`SELECT * FROM opening_learning_observations WHERE id=${oldAnswer.id}`)[0]).toEqual(oldObservation);
  expect((await sql`SELECT * FROM opening_help_exposures WHERE id=${help.id}`)[0]).toEqual(oldHelp);
  const answer = await f.submit(reopened, { sessionId: session.id, outcome: "unverified" });
  const evidence = await readOpeningLearningEvidenceContext(sql, scope, answer);
  expect(evidence.context.helpHistory?.exposures).toEqual(expect.arrayContaining([
    expect.objectContaining({ attemptId: legacy.id, problemId: legacy.problemId, kind: "solution", level: "revealed", delivered: true }),
  ]));
  expect(answer.eligibility.reasonCodes).toContain("prior_answer_exposure");
  expect(answer.eligibility.usableForDelayedCheck).not.toBe("yes");
  expect(await sql`SELECT id FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}`).toEqual([{ id: help.id }]);
});

it("upgrades a ref predating item versions without dropping its legacy help uncertainty", async () => {
  const f = await learningAttemptFixture(fixture), problemId = randomUUID();
  await f.learning.upsertProblemRef(fixture.scope, { problemId, sessionId: f.sessionId, sourceId: f.sourceId, sourceVersion: 1,
    physicalPage: question.page, chunkId: f.chunkId, stemSnapshot: question.stem, artifactKind: "reference_item" });
  const rows = backupRows(fixture.sql, fixture.scope), conversation = await rows.conversation(), turnId = await rows.turn(conversation, [f.sourceId]);
  await fixture.sql`UPDATE opening_turns SET learning_session_id=${f.sessionId} WHERE id=${turnId}`;
  await f.learning.insertHelpExposure(fixture.scope, { id: randomUUID(), sessionId: f.sessionId, problemId,
    turnId, kind: "solution", level: "revealed", delivered: true });
  await classify(f);
  const attempt = await startCanonical(f);
  expect(attempt.problemId).toBe(problemId);
  expect((await historyState(f)).items).toEqual([expect.objectContaining({ problem_id: problemId,
    evaluation_spec: { kind: "material_question", ...identity(f) } })]);
  const answer = await f.submit(attempt, { outcome: "unverified" });
  expect(answer.eligibility.reasonCodes).toContain("help_association_unknown");
  expect(answer.eligibility.independentAttempt).not.toBe("yes");
});

it("rejects duplicate legacy identities through both entry points without choosing the oldest or writing a fresh identity", async () => {
  const f = await learningAttemptFixture(fixture), first = await f.start(), second = await f.start();
  expect(first.problemId).not.toBe(second.problemId);
  await f.help(first, "revealed");
  await classify(f);
  const before = await historyState(f);
  await expect(startCanonical(f)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(startSupplied(f, first.problemId!)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(startSupplied(f, second.problemId!)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(f.start()).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await historyState(f)).toEqual(before);
});

it.each(["missing page", "different stem"] as const)("rejects %s rather than silently treating unresolved old exposure as unseen", async defect => {
  const f = await learningAttemptFixture(fixture);
  const legacy = await f.start({ problem: { sourceId: f.sourceId, artifactKind: "reference_item",
    physicalPage: defect === "missing page" ? null : 1, stemSnapshot: defect === "different stem" ? "Unverified transcription" : question.stem } });
  await f.help(legacy, "revealed");
  await classify(f);
  const before = await historyState(f);
  await expect(startCanonical(f)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(startSupplied(f, legacy.problemId!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await historyState(f)).toEqual(before);
});

it.each(["family", "subquestion"] as const)("does not infer a legacy %s from identical page/stem text", async dimension => {
  const f = await learningAttemptFixture(fixture), legacy = await f.start();
  const other = { ...question, [dimension]: "another" };
  await classify(f, [question, other]);
  const before = await historyState(f);
  await expect(startCanonical(f)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(startCanonical(f, other)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(startSupplied(f, legacy.problemId!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await historyState(f)).toEqual(before);
});

it("keeps equal-text canonical families and subquestions distinct, including repeat supplied-ID opens", async () => {
  const f = await learningAttemptFixture(fixture);
  const questions = [question, { ...question, family: "other-family" }, { ...question, subquestion: "b" }];
  await classify(f, questions);
  const attempts: LearningAttempt[] = [];
  for (const q of questions) attempts.push(await startCanonical(f, q));
  expect(new Set(attempts.map(a => a.problemId)).size).toBe(questions.length);
  expect(new Set(attempts.map(a => a.itemVersionId)).size).toBe(questions.length);
  for (const [index, q] of questions.entries()) {
    expect((await startCanonical(f, q)).itemVersionId).toBe(attempts[index]!.itemVersionId);
    expect((await startSupplied(f, attempts[index]!.problemId!)).itemVersionId).toBe(attempts[index]!.itemVersionId);
  }
});

it("uses the physical page to disambiguate equal legacy stems rather than a global text match", async () => {
  const f = await learningAttemptFixture(fixture), first = await f.start();
  await fixture.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${f.sourceId},1,2,'another exercise page')`;
  const second = await f.start({ problem: { sourceId: f.sourceId, physicalPage: 2,
    stemSnapshot: question.stem, artifactKind: "reference_item" } });
  const nextQuestion = { ...question, number: "2", page: 2 };
  await classify(f, [question, nextQuestion]);
  expect((await startCanonical(f)).problemId).toBe(first.problemId);
  expect((await startCanonical(f, nextQuestion)).problemId).toBe(second.problemId);
});

it("serializes simultaneous canonical and supplied-ID upgrades into one new immutable item", async () => {
  const f = await learningAttemptFixture(fixture), legacy = await f.start();
  await classify(f);
  const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId] });
  // Real postgres.js transactions / pooled connections exercise the history lock;
  // no SQL transport mocks or in-memory PG substitute.
  const [canonical, supplied] = await Promise.all([startCanonical(f), startSupplied(f, legacy.problemId!, session.id)]);
  expect(canonical.problemId).toBe(legacy.problemId);
  expect(supplied.problemId).toBe(legacy.problemId);
  expect(canonical.itemVersionId).toBe(supplied.itemVersionId);
  expect(canonical.itemVersionId).not.toBe(legacy.itemVersionId);
  expect((await historyState(f)).items).toHaveLength(2);
});

it("retains immutable legacy snapshots after an upsert moves the mutable ref, so neither route invents unseen history", async () => {
  const f = await learningAttemptFixture(fixture), legacy = await f.start();
  await f.help(legacy, "revealed");
  await f.learning.upsertProblemRef(fixture.scope, { problemId: legacy.problemId!, sessionId: f.sessionId,
    sourceId: f.sourceId, sourceVersion: 1, physicalPage: 1, chunkId: f.chunkId, stemSnapshot: "different saved ref", artifactKind: "reference_item" });
  await classify(f);
  const before = await historyState(f);
  await expect(startCanonical(f)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(startSupplied(f, legacy.problemId!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await historyState(f)).toEqual(before);
});

it.each(["legacy", "canonical"] as const)("cannot detach a classified %s item's source and reopen its supplied ID as plain text", async kind => {
  const f = await learningAttemptFixture(fixture), legacy = await f.start();
  await classify(f);
  if (kind === "canonical") await startCanonical(f);
  // Simulates an incomplete restore/changed mutable ref; no immutable item is rewritten.
  await fixture.sql`UPDATE opening_problem_refs SET source_id=NULL,source_version=NULL,physical_page=NULL,chunk_id=NULL
    WHERE problem_id=${legacy.problemId!}`;
  const before = await historyState(f);
  await expect(startSupplied(f, legacy.problemId!)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(startCanonical(f)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await historyState(f)).toEqual(before);
});

it("does not substitute a current manifest version for a supplied legacy ref's captured version", async () => {
  const f = await learningAttemptFixture(fixture), legacy = await f.start();
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await backupRows(fixture.sql, fixture.scope).chunk(f.sourceId, 2);
  await classify(f, [question], 2);
  const before = await historyState(f);
  await expect(startSupplied(f, legacy.problemId!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await historyState(f)).toEqual(before);
  const current = await startCanonical(f, question, f.sessionId, 2);
  expect(current.problemId).not.toBe(legacy.problemId);
  expect(current.sourceVersions).toEqual({ [f.sourceId]: 2 });
});

it("fails closed if a saved canonical item loses its manifest instead of falling back to generic grading identity", async () => {
  const f = await learningAttemptFixture(fixture);
  await classify(f);
  const canonical = await startCanonical(f);
  await fixture.sql`UPDATE opening_source_versions SET material_manifest=NULL WHERE source_id=${f.sourceId} AND version=1`;
  const before = await historyState(f);
  await expect(startSupplied(f, canonical.problemId!)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(startCanonical(f)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await historyState(f)).toEqual(before);
});

it("does not reuse a question across courses, sources or owners despite equal text and original numbering", async () => {
  const f = await learningAttemptFixture(fixture), legacy = await f.start(), { sql, scope } = fixture;
  const otherCourse = randomUUID();
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${otherCourse},${scope.workspaceId},'Other course',${otherCourse})`;
  const session = await f.learning.createSession(scope, { courseId: otherCourse, skillLabel: "fractions", sourceIds: [f.sourceId] });
  // Two ambiguous old refs in a different course must not poison this course's match.
  for (let i = 0; i < 2; i++) {
    await f.attempts.create(scope, { sessionId: session.id, clientKey: randomUUID(), problem: {
      sourceId: f.sourceId, physicalPage: 1, stemSnapshot: question.stem, artifactKind: "reference_item" } });
  }
  await classify(f);
  const canonical = await startCanonical(f);
  expect(canonical.problemId).toBe(legacy.problemId);
  await expect(startSupplied(f, legacy.problemId!, session.id)).rejects.toMatchObject({ code: "VALIDATION" });
  const other = await learningAttemptFixture({ ...fixture, scope: fixture.otherScope });
  await createOpeningMaterialManifestRepository(sql).write(fixture.otherScope, other.sourceId, {
    sourceVersion: 1, expectedRevision: 0, manifest: { role: "exercise", sections: [], questions: [question], answers: [] },
  });
  await expect(other.attempts.create(fixture.otherScope, { sessionId: other.sessionId, clientKey: randomUUID(), problemId: legacy.problemId }))
    .rejects.toMatchObject({ code: "VALIDATION" });
  await expect(other.attempts.create(fixture.otherScope, { sessionId: other.sessionId, clientKey: randomUUID(), materialQuestion: identity(f) }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  const otherAttempt = await other.attempts.create(fixture.otherScope, { sessionId: other.sessionId, clientKey: randomUUID(), materialQuestion: identity(other) });
  expect(otherAttempt.problemId).not.toBe(canonical.problemId);
  expect(await f.attempts.get(fixture.otherScope, canonical.id)).toBeNull();
  const rows = backupRows(sql, scope), secondSource = await rows.source();
  await rows.chunk(secondSource);
  await createOpeningMaterialManifestRepository(sql).write(scope, secondSource, {
    sourceVersion: 1, expectedRevision: 0, manifest: { role: "exercise", sections: [], questions: [question], answers: [] },
  });
  const secondSession = await f.learning.createSession(scope, { courseId: f.courseId, skillLabel: "fractions", sourceIds: [secondSource] });
  const second = await f.attempts.create(scope, { sessionId: secondSession.id, clientKey: randomUUID(),
    materialQuestion: { ...identity(f), sourceId: secondSource } });
  expect(second.problemId).not.toBe(canonical.problemId);
});

it("keeps role-only lecture compatibility without admitting questions from isolated answer pages", async () => {
  const f = await learningAttemptFixture(fixture), legacy = await f.start(), repo = createOpeningMaterialManifestRepository(fixture.sql);
  await repo.write(fixture.scope, f.sourceId, { sourceVersion: 1, expectedRevision: 0,
    manifest: { role: "lecture", sections: [], questions: [], answers: [] } });
  expect((await startSupplied(f, legacy.problemId!)).itemVersionId).toBe(legacy.itemVersionId);
  await repo.write(fixture.scope, f.sourceId, { sourceVersion: 1, expectedRevision: 1,
    manifest: { role: "answer_key", sections: [], questions: [], answers: [] } });
  const before = await historyState(f);
  await expect(startSupplied(f, legacy.problemId!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await historyState(f)).toEqual(before);
});
