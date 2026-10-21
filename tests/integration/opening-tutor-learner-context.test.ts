import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningTutorLearnerContextRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
async function wrongAnswer() {
  const f = await learningAttemptFixture(fixture), original = await f.submit(await f.start(), { outcome: "unverified", answer: "2" });
  const graded = await createOpeningAiGradingRepository(fixture.sql).apply(fixture.scope, { observationId: original.id }, {
    outcome: "incorrect", questionMatch: true, confidence: 0.95, feedback: "同分母相加只加分子，分母保持不变。",
    criteria: [{ label: "分母", verdict: "incorrect", feedback: "不应把分母相加。" }],
  }, "fixture");
  const repository = createOpeningTutorLearnerContextRepository(fixture.sql);
  return { ...f, original, graded, repository, read: () => repository.read(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId] }) };
}

it("provides course goal, current mistakes and provenance without crossing courses or ignoring material selections", async () => {
  const f = await wrongAnswer(), other = await wrongAnswer();
  await fixture.sql`UPDATE courses SET description='十天后期末，完成基础题' WHERE id=${f.courseId}`;
  const prefs = { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoals: { [f.courseId]: { targetDate: "2026-10-31", weeklyMinutes: 420 } } };
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,adaptive_planning) VALUES(${fixture.scope.workspaceId},${fixture.sql.json(prefs)})
    ON CONFLICT(workspace_id) DO UPDATE SET adaptive_planning=EXCLUDED.adaptive_planning`;
  const context = await f.read();
  expect(context).toMatchObject({ courseId: f.courseId, goal: { description: "十天后期末，完成基础题", targetDate: "2026-10-31", weeklyMinutes: 420 },
    weaknesses: [{ skillLabel: "fractions", incorrect: 1, samples: 1 }],
    recentMistakes: [{ observationId: f.graded.id, feedback: "同分母相加只加分子，分母保持不变。", unmetCriteria: ["分母：不应把分母相加。"] }],
    sourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }] });
  expect(context!.observationIds).not.toContain(other.graded.id);
  await expect(f.repository.assertCurrent(fixture.scope, context!)).resolves.toBeUndefined();
  expect(await f.repository.read(fixture.scope, { courseId: f.courseId, sourceIds: [] })).toMatchObject({ weaknesses: [], recentMistakes: [], sourceRefs: [] });
  await expect(f.repository.read(fixture.otherScope, { courseId: f.courseId, sourceIds: [f.sourceId] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await f.repository.read(fixture.scope, { sourceIds: [] })).toBeNull();
});

it("uses effective heads and refuses a corrected or retracted snapshot before model send", async () => {
  const f = await wrongAnswer(), context = await f.read();
  await f.learning.reviseObservation(fixture.scope, { rootObservationId: f.original.id, revisesObservationId: f.graded.id,
    expectedHead: f.graded.id, revisionKind: "replace", clientKey: randomUUID(), reason: "判错了",
    replacement: { answer: "1", outcome: "correct", assistance: "independent" } });
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.read()).toMatchObject({ weaknesses: [{ incorrect: 0, assisted: 1 }], recentMistakes: [] });
});

it("excludes unavailable and privacy-blocked evidence, including a change between reading and sending", async () => {
  const f = await wrongAnswer(), context = await f.read();
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.read()).toMatchObject({ weaknesses: [], recentMistakes: [], sourceRefs: [] });
  await fixture.sql`UPDATE opening_sources SET version=1 WHERE id=${f.sourceId}`;
  await backupRows(fixture.sql, fixture.scope).exclude(f.sourceId);
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.read()).toMatchObject({ weaknesses: [], recentMistakes: [], sourceRefs: [] });
});

it("does not let five recent strong skills hide an earlier current weakness", async () => {
  const f = await wrongAnswer();
  for (let index = 0; index < 5; index++) {
    const skillLabel = `strong skill ${index}`;
    const session = await f.learning.createSession(fixture.scope, { courseId: f.courseId, skillLabel, sourceIds: [f.sourceId] });
    const original = await f.submit(await f.start({ sessionId: session.id }), { sessionId: session.id, skillLabel, outcome: "unverified" });
    await createOpeningAiGradingRepository(fixture.sql).apply(fixture.scope, { observationId: original.id }, {
      outcome: "correct", questionMatch: true, confidence: 0.95, feedback: "计算正确。", criteria: [{ label: "计算", verdict: "correct", feedback: "相加得一。" }],
    }, "fixture");
  }
  expect(await f.read()).toMatchObject({ weaknesses: [{ skillLabel: "fractions", incorrect: 1 }], observationIds: [f.graded.id] });
});

it("captures all correction lineage sources and refuses unversioned, unselected or changed ancestors", async () => {
  const f = await wrongAnswer(), ancestorSource = await backupRows(fixture.sql, fixture.scope).source();
  // Models a legacy revision whose effective head narrowed attribution after consuming another material.
  await fixture.sql`UPDATE opening_learning_observations SET source_ids=${[f.sourceId, ancestorSource]},
    source_versions=${fixture.sql.json({ [f.sourceId]: 1, [ancestorSource]: 1 })} WHERE id=${f.original.id}`;
  expect(await f.read()).toMatchObject({ weaknesses: [], recentMistakes: [], sourceRefs: [] });
  const read = () => f.repository.read(fixture.scope, { courseId: f.courseId, sourceIds: [f.sourceId, ancestorSource] });
  const context = await read();
  expect(context).toMatchObject({ recentMistakes: [{ observationId: f.graded.id }], sourceRefs: expect.arrayContaining([
    { sourceId: f.sourceId, sourceVersion: 1 }, { sourceId: ancestorSource, sourceVersion: 1 },
  ]) });
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${ancestorSource}`;
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await read()).toMatchObject({ recentMistakes: [], sourceRefs: [] });
  await fixture.sql`UPDATE opening_sources SET version=1 WHERE id=${ancestorSource}`;
  await fixture.sql`UPDATE opening_learning_observations SET source_versions=${fixture.sql.json({ [f.sourceId]: 1 })} WHERE id=${f.original.id}`;
  expect(await read()).toMatchObject({ recentMistakes: [], sourceRefs: [] });
  await fixture.sql`UPDATE opening_learning_observations SET source_versions=${fixture.sql.json({ [f.sourceId]: 1, [ancestorSource]: 1 })} WHERE id=${f.original.id}`;
  await backupRows(fixture.sql, fixture.scope).exclude(ancestorSource);
  await expect(f.repository.assertCurrent(fixture.scope, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await read()).toMatchObject({ recentMistakes: [], sourceRefs: [] });
});
