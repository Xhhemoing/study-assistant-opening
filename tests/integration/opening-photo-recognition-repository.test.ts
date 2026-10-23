import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createOpeningPhotoRecognitionRepository, createOpeningJobRepository, openingJobScope } from "@aistudy/database";
import { BudgetReplayError, OpeningProviderError, type ModelGateway } from "@aistudy/ai";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { createRecognizePhotoQuestionHandler } from "../../apps/worker/src/jobs/recognize-photo-question";
import { runJob } from "../../apps/worker/src/runtime/run-job";
let fixture: OpeningFixture;
const proposal = { stem: "计算 1+1", uncertainFragments: [] };
let sourceId: string;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset(); sourceId = randomUUID();
  await fixture.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${fixture.scope.workspaceId},'question.png','image/png',100,${"a".repeat(64)},0,'uploaded','queued')`;
});
afterAll(async () => { await fixture?.close(); });
const repo = () => createOpeningPhotoRecognitionRepository(fixture.sql);
const jobs = () => createOpeningJobRepository(fixture.sql);
const input = () => ({ sourceId, sourceVersion: 0 });
it("GET stays read-only and repeated admission creates one durable job/outbox", async () => {
  expect(await repo().read(fixture.scope, input())).toMatchObject({ status: "idle", jobId: null });
  const first = await repo().begin(fixture.scope, input()), again = await repo().begin(fixture.scope, input());
  expect(again).toEqual(first);
  expect((await fixture.sql`SELECT id FROM opening_jobs WHERE kind='recognize-photo-question'`)).toHaveLength(1);
  expect((await fixture.sql`SELECT id FROM opening_outbox WHERE job_id=${first.jobId}`)).toHaveLength(1);
  expect(await repo().read(fixture.scope, input())).toEqual(first);
});
it("rejects foreign ownership and obsolete versions before creating a job", async () => {
  await expect(repo().begin(fixture.otherScope, input())).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repo().begin({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, input())).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repo().begin(fixture.scope, { ...input(), sourceVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await fixture.sql`SELECT id FROM opening_jobs WHERE kind='recognize-photo-question'`).toHaveLength(0);
});
it("fences privacy changes before send, publication and later result reads", async () => {
  const started = await repo().begin(fixture.scope, input());
  const job = (await jobs().claim(started.jobId!))!;
  await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${fixture.scope.workspaceId}`;
  await expect(repo().assertCurrent(openingJobScope(job), input())).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repo().complete(openingJobScope(job), input(), proposal)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repo().read(fixture.scope, input())).rejects.toMatchObject({ code: "CONFLICT" });
});
it("does not publish a late source revision or a cancelled execution", async () => {
  const started = await repo().begin(fixture.scope, input()), job = (await jobs().claim(started.jobId!))!;
  await fixture.sql`UPDATE opening_sources SET version=1 WHERE id=${sourceId}`;
  await expect(repo().complete(openingJobScope(job), input(), proposal)).rejects.toMatchObject({ code: "CONFLICT" });
  await fixture.sql`UPDATE opening_sources SET version=0 WHERE id=${sourceId}`;
  await jobs().cancel(fixture.scope, job.id);
  await expect(repo().complete(openingJobScope(job), input(), proposal)).rejects.toMatchObject({ code: "CONFLICT" });
});
it("a durable result survives settlement failure, stale finish/fail/recovery and replays without another model call", async () => {
  const started = await repo().begin(fixture.scope, input());
  type Options = Parameters<ModelGateway["call"]>[2];
  const call = vi.fn(async (_scope: unknown, _task: unknown, options: Options) => {
    await options.beforeSend?.();
    await options.persistResult?.({ text: JSON.stringify(proposal), inputTokens: 10, outputTokens: 20 }, { reservationId: randomUUID(), settledCents: 1 });
    throw new Error("settlement interrupted");
  });
  const handler = createRecognizePhotoQuestionHandler({ repository: repo(), gateway: { call }, budget: () => ({} as Options["budget"]),
    images: async () => [{ sourceId, physicalPage: 1, mediaType: "image/png", data: "data:image/png;base64,AAAA" }] });
  await runJob(jobs(), started.jobId!, handler);
  const saved = await jobs().get(fixture.scope, started.jobId!);
  expect(saved).toMatchObject({ state: "succeeded", result: proposal });
  expect(await jobs().finish(saved.id, "failed", { error: "late failure" }, saved.claimToken)).toBe(false);
  expect(await jobs().finish(saved.id, "succeeded", { stem: "wrong" }, saved.claimToken)).toBe(false);
  await fixture.sql`UPDATE opening_jobs SET updated_at=now()-interval '10 minutes' WHERE id=${saved.id}`;
  expect(await jobs().recoverExpired()).toBe(0);
  expect(await repo().read(fixture.scope, input())).toMatchObject({ status: "ready", proposal });
  expect(await repo().begin(fixture.scope, input())).toMatchObject({ status: "ready", jobId: saved.id });
  await runJob(jobs(), saved.id, handler);
  expect(call).toHaveBeenCalledOnce();
});
it.each([
  new OpeningProviderError("PROVIDER_TIMEOUT", "response lost", true, true),
  new OpeningProviderError("PROVIDER_ABORTED", "response interrupted", false, true),
  new OpeningProviderError("PROVIDER_RESPONSE", "response incomplete", false, true),
  new BudgetReplayError({ kind: "unknown", reservationId: "r1", pendingReconcileCents: 1, reconciled: false }),
  new BudgetReplayError({ kind: "in_flight", reservationId: "r1" }),
])("an unknown outcome stays terminal and replay does not send another paid request: %s", async failure => {
  const started = await repo().begin(fixture.scope, input());
  const call = vi.fn().mockRejectedValue(failure);
  const handler = createRecognizePhotoQuestionHandler({ repository: repo(), gateway: { call }, budget: () => ({} as Parameters<ModelGateway["call"]>[2]["budget"]),
    images: async () => [{ sourceId, physicalPage: 1, mediaType: "image/png", data: "data:image/png;base64,AAAA" }] });
  await runJob(jobs(), started.jobId!, handler);
  expect(await repo().read(fixture.scope, input())).toMatchObject({ status: "unknown", proposal: null });
  await repo().begin(fixture.scope, input()); await runJob(jobs(), started.jobId!, handler);
  expect(call).toHaveBeenCalledOnce();
});
it("privacy exclusion blocks a previously saved transcription", async () => {
  const started = await repo().begin(fixture.scope, input()), job = (await jobs().claim(started.jobId!))!;
  await repo().complete(openingJobScope(job), input(), proposal);
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${fixture.scope.workspaceId},${sourceId})`;
  await expect(repo().read(fixture.scope, input())).rejects.toMatchObject({ code: "CONFLICT" });
});
