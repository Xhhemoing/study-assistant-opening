import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import * as policyModule from "../../apps/web/src/features/opening/learning/auto-grade-policy";
import { createOpeningAiGradingJobRepository, type OpeningAutoGradePolicy, readOpeningAttemptGradingUsesVision } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions CASCADE`; });
afterAll(async () => { await fixture?.close(); });
const policy = (mediaMaxInputBytes: number): OpeningAutoGradePolicy => ({ enabled: true, modelAvailable: true, dailyCap: 50,
  dayStart: new Date(0), dayEnd: new Date(), budgetOptions: { envCapCents: 10000 },
  primaryModel: { supportsVision: true, inputCentsPerMillion: 100, outputCentsPerMillion: 100,
    modelSnapshot: { id: "luna", providerId: "fixture", modelName: "gpt-6-luna", inputCentsPerMillion: 100, outputCentsPerMillion: 100,
      mediaInputTokenUpperBound: 10000, mediaMaxInputBytes, mediaInputCentsPerMillion: 100 } } });
it("real text submission of a visual question selects vision, queues once, and replays after its chunk is removed", async () => {
  const f = await learningAttemptFixture(fixture);
  await fixture.sql`UPDATE opening_sources SET mime='image/png',bytes=100 WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET image_object_key=${`opening/sources/${f.sourceId}/v1`} WHERE id=${f.chunkId}`;
  const attempt = await f.start();
  expect(await readOpeningAttemptGradingUsesVision(fixture.sql, fixture.scope, attempt.id)).toBe(true);
  const spy = vi.spyOn(policyModule, "resolveAutoGradePolicy").mockResolvedValue(policy(100));
  try {
    const service = createOpeningAttemptService(fixture.sql), input = { clientKey: randomUUID(), answer: "1", outcome: "unverified", assistance: "independent" };
    const saved = await service.submit(fixture.scope, attempt.id, input);
    expect(spy).toHaveBeenCalledWith(fixture.sql, fixture.scope, true);
    expect(await createOpeningAiGradingJobRepository(fixture.sql).read(fixture.scope, { observationId: saved.id })).toMatchObject({ status: "queued" });
    await fixture.sql`DELETE FROM opening_source_chunks WHERE id=${f.chunkId}`;
    expect((await service.submit(fixture.scope, attempt.id, input)).id).toBe(saved.id);
    expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation' AND workspace_id=${fixture.scope.workspaceId}`).toHaveLength(1);
    expect(await fixture.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
  } finally { spy.mockRestore(); }
});
it("real typed answer with visual references over the model byte bound saves without a job and reports budget unavailable", async () => {
  const f = await learningAttemptFixture(fixture);
  await fixture.sql`UPDATE opening_sources SET mime='image/png',bytes=101 WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET image_object_key=${`opening/sources/${f.sourceId}/v1`} WHERE id=${f.chunkId}`;
  const attempt = await f.start(), p = policy(100);
  const spy = vi.spyOn(policyModule, "resolveAutoGradePolicy").mockResolvedValue(p);
  try {
    const saved = await createOpeningAttemptService(fixture.sql).submit(fixture.scope, attempt.id, { clientKey: randomUUID(), answer: "1", outcome: "unverified", assistance: "independent" });
    expect(saved.answer).toBe("1");
    expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation' AND workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
    expect(await createOpeningAiGradingJobRepository(fixture.sql).read(fixture.scope, { observationId: saved.id }, p)).toMatchObject({ autoGradeSkipped: "budget_unavailable" });
  } finally { spy.mockRestore(); }
});
it.each([false, true])("keeps an issued answer whose exact image chunk was removed before first submit (automatic %s)", async enabled => {
  const f = await learningAttemptFixture(fixture);
  await fixture.sql`UPDATE opening_sources SET mime='image/png',bytes=100 WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET image_object_key=${`opening/sources/${f.sourceId}/v1`} WHERE id=${f.chunkId}`;
  const attempt = await f.start();
  await fixture.sql`DELETE FROM opening_source_chunks WHERE id=${f.chunkId}`;
  expect(await readOpeningAttemptGradingUsesVision(fixture.sql, fixture.scope, attempt.id)).toBeNull();
  const spy = vi.spyOn(policyModule, "resolveAutoGradePolicy").mockResolvedValue({ ...policy(100), enabled });
  try {
    const saved = await createOpeningAttemptService(fixture.sql).submit(fixture.scope, attempt.id, { clientKey: randomUUID(), answer: "original work", outcome: "unverified", assistance: "independent" });
    expect(saved.answer).toBe("original work");
    expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation' AND workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
    expect(await fixture.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
  } finally { spy.mockRestore(); }
});
it.each([false, true])("preserves a typed answer after routing preflight loses its exact chunk (work photo %s)", async attachPhoto => {
  const f = await learningAttemptFixture(fixture);
  await fixture.sql`UPDATE opening_sources SET mime='image/png',bytes=100 WHERE id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET image_object_key=${`opening/sources/${f.sourceId}/v1`} WHERE id=${f.chunkId}`;
  const attempt = await f.start();
  const photoId = attachPhoto ? await backupRows(fixture.sql, fixture.scope).source() : null;
  if (photoId) await fixture.sql`UPDATE opening_sources SET mime='image/png',bytes=100 WHERE id=${photoId}`;
  const spy = vi.spyOn(policyModule, "resolveAutoGradePolicy").mockImplementationOnce(async (_db, _scope, vision) => {
    expect(vision).toBe(true);
    await fixture.sql`DELETE FROM opening_source_chunks WHERE id=${f.chunkId}`;
    return policy(1000);
  });
  try {
    const saved = await createOpeningAttemptService(fixture.sql).submit(fixture.scope, attempt.id, { clientKey: randomUUID(), answer: "original work", outcome: "unverified", assistance: "independent",
      ...(photoId ? { workSource: { id: photoId, version: 1, physicalPage: 1 } } : {}) });
    expect(saved.answer).toBe("original work");
    expect(saved.sourceVersions?.[f.sourceId]).toBe(1);
    if (photoId) expect(saved.sourceVersions?.[photoId]).toBe(1);
    const [row] = await fixture.sql`SELECT grading_work_source FROM opening_learning_observations WHERE id=${saved.id}`;
    expect(row?.grading_work_source).toEqual(photoId ? { id: photoId, version: 1, physicalPage: 1 } : null);
    expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='grade-observation' AND workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
    expect(await fixture.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
  } finally { spy.mockRestore(); }
});
it("still rejects a work photo from another workspace after the question reference disappears", async () => {
  const foreign = await createOpeningFixture();
  try {
    const f = await learningAttemptFixture(fixture);
    await fixture.sql`UPDATE opening_sources SET mime='image/png',bytes=100 WHERE id=${f.sourceId}`;
    await fixture.sql`UPDATE opening_source_chunks SET image_object_key=${`opening/sources/${f.sourceId}/v1`} WHERE id=${f.chunkId}`;
    const attempt = await f.start();
    const photoId = await backupRows(foreign.sql, foreign.scope).source();
    await foreign.sql`UPDATE opening_sources SET mime='image/png',bytes=100 WHERE id=${photoId}`;
    const spy = vi.spyOn(policyModule, "resolveAutoGradePolicy").mockImplementationOnce(async () => {
      await fixture.sql`DELETE FROM opening_source_chunks WHERE id=${f.chunkId}`;
      return policy(1000);
    });
    try {
      await expect(createOpeningAttemptService(fixture.sql).submit(fixture.scope, attempt.id, { clientKey: randomUUID(), answer: "original work", outcome: "unverified", assistance: "independent",
        workSource: { id: photoId, version: 1, physicalPage: 1 } })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE attempt_id=${attempt.id}`).toHaveLength(0);
    } finally { spy.mockRestore(); }
  } finally { await foreign.close(); }
});
