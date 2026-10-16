import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MeasurementOverview } from "@aistudy/contracts";
import { createOpeningMeasurementRepository } from "@aistudy/database";
import { getMeasurementUnit } from "@aistudy/domain/measurement-catalog";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
let courseId: string;
let repository: ReturnType<typeof createOpeningMeasurementRepository>;
const unit = getMeasurementUnit("calculus-parts-v1")!;
const key = () => `measurement:${randomUUID()}`;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  repository = createOpeningMeasurementRepository(fixture.sql);
});
beforeEach(async () => {
  await fixture.sql`TRUNCATE opening_measurement_trials CASCADE`;
  courseId = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES
    (${courseId},${fixture.scope.workspaceId},'Measurement course',${courseId})`;
});
afterAll(async () => { await fixture?.close(); });

async function start(): Promise<MeasurementOverview> {
  return repository.start(fixture.scope, { courseId, unitId: "calculus-parts-v1", clientKey: key() });
}
async function issue(trialId: string): Promise<MeasurementOverview> {
  return repository.next(fixture.scope, { trialId, clientKey: key() });
}
async function answerLast(overview: MeasurementOverview): Promise<MeasurementOverview> {
  const attempt = overview.attempts.at(-1)!;
  const answer = unit.items.find(item => item.id === attempt.item.id)!.correctOptionId;
  return repository.act(fixture.scope, attempt.id, { action: "answer", answer, clientKey: key() });
}
async function finishPractice(): Promise<MeasurementOverview> {
  let overview = await start();
  for (let index = 0; index < 6; index += 1) overview = await answerLast(await issue(overview.trial!.id));
  return overview;
}

describe("isolated real-use measurement repository", () => {
  it("authorizes ownership for enrollment, reads, issue, answers, status, and export", async () => {
    const overview = await issue((await start()).trial!.id);
    const trialId = overview.trial!.id, attemptId = overview.attempts[0]!.id;
    await expect(repository.start(fixture.otherScope, { courseId, unitId: "calculus-parts-v1", clientKey: key() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.read(fixture.otherScope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.next(fixture.otherScope, { trialId, clientKey: key() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.act(fixture.otherScope, attemptId, { action: "skip", clientKey: key() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.setStatus(fixture.otherScope, { trialId, status: "paused" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.export(fixture.otherScope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.read({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enrolls once under concurrent retries and finds the original course without allowing a reset", async () => {
    const input = { courseId, unitId: "calculus-parts-v1" as const, clientKey: key() };
    const [a, b] = await Promise.all([repository.start(fixture.scope, input), repository.start(fixture.scope, input)]);
    expect(a.trial!.id).toBe(b.trial!.id);
    expect((await start()).trial!.id).toBe(a.trial!.id);
    const otherCourse = randomUUID();
    await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${otherCourse},${fixture.scope.workspaceId},'Other course',${otherCourse})`;
    await expect(repository.start(fixture.scope, { ...input, courseId: otherCourse })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.start(fixture.scope, { ...input, courseId: otherCourse, clientKey: key() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repository.read(fixture.scope, otherCourse)).trial!.courseId).toBe(courseId);
    const rows = await fixture.sql`SELECT * FROM opening_measurement_trials WHERE workspace_id=${fixture.scope.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.catalog).toHaveLength(12);
  });

  it("persists the same pre-answer forecasts and one pending item under concurrent issue calls", async () => {
    const trialId = (await start()).trial!.id;
    const [a, b] = await Promise.all([issue(trialId), issue(trialId)]);
    expect(a.attempts[0]!.id).toBe(b.attempts[0]!.id);
    const pending = a.attempts[0]!;
    expect(pending).toMatchObject({ ordinal: 1, firstAttempt: true, answer: null, outcome: null, answeredAt: null });
    expect(pending.predictions).toEqual([]);
    expect(pending.item).not.toHaveProperty("correctOptionId");
    expect(pending.item).not.toHaveProperty("hint");
    expect(pending.item).not.toHaveProperty("solution");
    const [stored] = await fixture.sql`SELECT predictions,outcome FROM opening_measurement_attempts WHERE id=${pending.id}`;
    expect(stored!.predictions).toHaveLength(2);
    expect((stored!.predictions as Array<{ predictedAt: string; evidenceAttemptIds: string[] }>).every(prediction =>
      prediction.predictedAt === pending.presentedAt && prediction.evidenceAttemptIds.length === 0)).toBe(true);
    expect(stored!.outcome).toBeNull();
    expect((await repository.export(fixture.scope, courseId)).attempts[0]!.predictions).toEqual([]);
  });

  it("grades on the server, rejects invalid inputs, preserves forecasts and replays exactly once", async () => {
    const overview = await issue((await start()).trial!.id);
    const attempt = overview.attempts[0]!;
    const [storedBefore] = await fixture.sql`SELECT predictions FROM opening_measurement_attempts WHERE id=${attempt.id}`;
    await expect(repository.act(fixture.scope, attempt.id, { action: "answer", answer: "not-an-option", clientKey: key() })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await repository.read(fixture.scope, courseId)).attempts[0]!.answeredAt).toBeNull();
    const answer = unit.items[0]!.correctOptionId;
    const input = { action: "answer" as const, answer, clientKey: key() };
    const result = await repository.act(fixture.scope, attempt.id, input);
    const replay = await repository.act(fixture.scope, attempt.id, input);
    expect(replay.attempts[0]).toEqual(result.attempts[0]);
    expect(result.attempts[0]!.outcome).toBe("correct");
    expect(result.attempts[0]!.predictions).toEqual(storedBefore!.predictions);
    expect(Date.parse(result.attempts[0]!.answeredAt!)).toBeGreaterThanOrEqual(Date.parse(attempt.presentedAt));
    await expect(repository.act(fixture.scope, attempt.id, { ...input, answer: "invalid" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.act(fixture.scope, attempt.id, { ...input, clientKey: key() })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("serializes competing answer and skip commands without overwriting the winner", async () => {
    const overview = await issue((await start()).trial!.id);
    const attempt = overview.attempts[0]!;
    const results = await Promise.allSettled([
      repository.act(fixture.scope, attempt.id, { action: "answer", answer: unit.items[0]!.correctOptionId, clientKey: key() }),
      repository.act(fixture.scope, attempt.id, { action: "skip", clientKey: key() }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const stored = await repository.read(fixture.scope, courseId);
    expect(stored.attempts[0]!.answeredAt).not.toBeNull();
  });

  it("records actual help before delivering content and excludes helped answers from both models", async () => {
    const overview = await issue((await start()).trial!.id);
    const attempt = overview.attempts[0]!;
    const input = { action: "help" as const, kind: "hint" as const, clientKey: key() };
    const helped = await repository.act(fixture.scope, attempt.id, input);
    expect(helped.attempts[0]!.feedback).toBe(unit.items[0]!.hint);
    expect(helped.attempts[0]!.helpEvents).toHaveLength(1);
    expect((await repository.act(fixture.scope, attempt.id, input)).attempts[0]!.helpEvents).toHaveLength(1);
    const revealed = await repository.act(fixture.scope, attempt.id, { action: "help", kind: "solution", clientKey: key() });
    expect(revealed.attempts[0]!.feedback).toBe(unit.items[0]!.solution);
    const answered = await answerLast(revealed);
    expect(answered.report.eligible).toBe(0);
    expect(answered.report.excluded.assisted).toBe(1);
    expect(answered.report.models.every(model => model.count === 0)).toBe(true);
  });

  it("keeps pending and skipped answers visible as missingness instead of incorrect answers", async () => {
    const overview = await issue((await start()).trial!.id);
    expect(overview.report).toMatchObject({ presented: 1, answered: 0, pending: 1, skipped: 0, eligible: 0 });
    const skipped = await repository.act(fixture.scope, overview.attempts[0]!.id, { action: "skip", clientKey: key() });
    expect(skipped.report).toMatchObject({ presented: 1, answered: 1, pending: 0, skipped: 1, eligible: 0 });
    expect(skipped.attempts[0]!.answer).toBeNull();
    expect(skipped.attempts[0]!.outcome).toBe("skipped");
  });

  it("pauses and resumes the same pending item without restarting time or first-attempt identity", async () => {
    const overview = await issue((await start()).trial!.id);
    const trialId = overview.trial!.id;
    await repository.setStatus(fixture.scope, { trialId, status: "paused" });
    await expect(issue(trialId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.act(fixture.scope, overview.attempts[0]!.id, { action: "skip", clientKey: key() })).rejects.toMatchObject({ code: "CONFLICT" });
    await repository.setStatus(fixture.scope, { trialId, status: "active" });
    const resumed = await issue(trialId);
    expect(resumed.attempts[0]).toEqual(overview.attempts[0]);
    expect(resumed.trial!.startedAt).toBe(overview.trial!.startedAt);
  });

  it("enforces real 48-hour and 7-day gates and withholds every feedback/export scoring channel until the phase closes", async () => {
    let overview = await finishPractice();
    const trialId = overview.trial!.id;
    expect(overview.trial!.practiceCompletedAt).not.toBeNull();
    expect(Date.parse(overview.nextDueAt!) - Date.parse(overview.trial!.practiceCompletedAt!)).toBe(48 * 60 * 60 * 1000);
    await expect(issue(trialId)).rejects.toMatchObject({ code: "CONFLICT" });
    await fixture.sql`UPDATE opening_measurement_trials SET practice_completed_at=clock_timestamp()-interval '49 hours' WHERE id=${trialId}`;
    overview = await issue(trialId);
    const delayed = overview.attempts.at(-1)!;
    expect(delayed.item.phase).toBe("delay_48h");
    const practicedFamilies = new Set(overview.attempts.filter(attempt => attempt.item.phase === "practice").map(attempt => attempt.item.familyId));
    expect(practicedFamilies.has(delayed.item.familyId)).toBe(false);
    await expect(repository.act(fixture.scope, delayed.id, { action: "help", kind: "hint", clientKey: key() })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.act(fixture.scope, delayed.id, { action: "help", kind: "solution", clientKey: key() })).rejects.toMatchObject({ code: "CONFLICT" });
    overview = await answerLast(overview);
    expect(overview.attempts.at(-1)).toMatchObject({ outcome: null, predictions: [], feedbackWithheld: true, feedback: "已保存，完成本轮后查看解析" });
    expect(overview.report.eligible).toBe(6);
    const exported = await repository.export(fixture.scope, courseId);
    expect(exported.attempts.at(-1)!.outcome).toBeNull();
    expect(exported.attempts.at(-1)!.predictions).toEqual([]);
    expect(JSON.stringify(exported)).not.toContain("correctOptionId");
    for (let index = 0; index < 2; index += 1) overview = await answerLast(await issue(trialId));
    expect(overview.attempts.filter(attempt => attempt.item.phase === "delay_48h").every(attempt => attempt.outcome === "correct" && !attempt.feedbackWithheld)).toBe(true);
    expect(overview.report.eligible).toBe(9);
    await expect(issue(trialId)).rejects.toMatchObject({ code: "CONFLICT" });
    await fixture.sql`UPDATE opening_measurement_trials SET practice_completed_at=clock_timestamp()-interval '8 days' WHERE id=${trialId}`;
    for (let index = 0; index < 3; index += 1) overview = await answerLast(await issue(trialId));
    expect(overview.trial!.status).toBe("completed");
    // These fixture responses occur immediately after the 48h phase, so the
    // 7d phase is retained but cannot qualify as an independent delayed score.
    expect(overview.report.eligible).toBe(9);
    expect(overview.attempts.filter(attempt => attempt.item.phase === "delay_7d").every(attempt => attempt.firstAttempt && attempt.dueAt !== null)).toBe(true);
    await expect(repository.setStatus(fixture.scope, { trialId, status: "active" })).rejects.toMatchObject({ code: "CONFLICT" });
    const original = overview.attempts[0]!;
    const retracted = await repository.act(fixture.scope, original.id, { action: "retract", reason: "误触选项", clientKey: key() });
    expect(retracted.attempts[0]!.outcome).toBe("correct");
    expect(retracted.attempts[0]!.retractedAt).not.toBeNull();
    expect(retracted.attempts[0]!.predictions).toEqual(original.predictions);
    expect(retracted.report.excluded.retracted).toBe(1);
    expect(retracted.report.excluded.invalidated_history).toBeGreaterThan(0);
  });

  it("logs outside help on delayed probes, and excludes it after feedback is released", async () => {
    const practice = await finishPractice();
    const trialId = practice.trial!.id;
    await fixture.sql`UPDATE opening_measurement_trials SET practice_completed_at=clock_timestamp()-interval '49 hours' WHERE id=${trialId}`;
    let overview = await issue(trialId);
    await repository.act(fixture.scope, overview.attempts.at(-1)!.id, { action: "help", kind: "external", clientKey: key() });
    overview = await answerLast(overview);
    for (let index = 0; index < 2; index += 1) overview = await answerLast(await issue(trialId));
    expect(overview.report.excluded.assisted).toBe(1);
    expect(overview.report.eligible).toBe(8);
  });

  it("rejects unreadable persisted gold and incompatible predictor parameters before presentation", async () => {
    const trialId = (await start()).trial!.id;
    await fixture.sql`UPDATE opening_measurement_trials SET catalog='[{"id":"broken"}]'::jsonb WHERE id=${trialId}`;
    await expect(issue(trialId)).rejects.toBeDefined();
    const rows = await fixture.sql`SELECT id FROM opening_measurement_attempts WHERE trial_id=${trialId}`;
    expect(rows).toHaveLength(0);
    await fixture.sql`UPDATE opening_measurement_trials SET catalog=${fixture.sql.json(unit.items as never)},
      models=jsonb_set(models,'{0,parameters,guess}','0.99'::jsonb) WHERE id=${trialId}`;
    await expect(issue(trialId)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repository.read(fixture.scope, courseId)).attempts).toHaveLength(0);
  });

  it("does not create production learning observations, sessions, or tasks", async () => {
    const before = await fixture.sql`SELECT
      (SELECT count(*) FROM opening_learning_observations) AS observations,
      (SELECT count(*) FROM opening_learning_sessions) AS sessions,
      (SELECT count(*) FROM opening_tasks) AS tasks`;
    await answerLast(await issue((await start()).trial!.id));
    const after = await fixture.sql`SELECT
      (SELECT count(*) FROM opening_learning_observations) AS observations,
      (SELECT count(*) FROM opening_learning_sessions) AS sessions,
      (SELECT count(*) FROM opening_tasks) AS tasks`;
    expect(after).toEqual(before);
  });

  it("keeps archived-course evidence readable and exportable while blocking new measurement writes", async () => {
    const overview = await answerLast(await issue((await start()).trial!.id));
    await fixture.sql`UPDATE courses SET archived_at=clock_timestamp() WHERE id=${courseId}`;
    const exported = await repository.export(fixture.scope, courseId);
    expect(exported.trial!.id).toBe(overview.trial!.id);
    expect(exported.attempts).toEqual(overview.attempts);
    await expect(issue(overview.trial!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.export(fixture.otherScope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
