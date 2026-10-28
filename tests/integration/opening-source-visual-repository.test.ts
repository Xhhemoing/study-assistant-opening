import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningSourceVisualRecognitionsRepository, createOpeningAiGradingRepository, createOpeningSourceChunksRepository, type OpeningJobScope } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => { await f.reset(); });
afterAll(async () => { await f?.close(); });
async function seed() {
  const sourceId = randomUUID(), jobId = randomUUID(), token = randomUUID();
  const [workspace] = await f.sql`SELECT privacy_epoch FROM workspaces WHERE id=${f.scope.workspaceId}`;
  const privacyEpoch = Number(workspace!.privacy_epoch);
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${f.scope.workspaceId},'scan','image/png',100,${"a".repeat(64)},0,'uploaded','queued')`;
  await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state,claim_token,privacy_epoch)
    VALUES(${jobId},${f.scope.workspaceId},${f.scope.ownerUserId},${jobId},'parse',${f.sql.json({ sourceId, sourceVersion: 0 })},'running',${token},${privacyEpoch})`;
  const scope: OpeningJobScope = { ...f.scope, jobExecution: { id: jobId, token, privacyEpoch } };
  const identity = { sourceId, sourceVersion: 0, physicalPage: 1 };
  const record = { result: { transcription: "\\frac{1}{x+2}", description: "", uncertainties: [], contentKinds: ["formula" as const] },
    modelSnapshot: { id: "luna", providerId: "configured", modelName: "gpt-6-luna", inputCentsPerMillion: 10, outputCentsPerMillion: 50 },
    operationId: `visual:${sourceId}`, imageObjectKey: `opening/sources/${sourceId}/v0` };
  return { scope, identity, record, jobId, repo: createOpeningSourceVisualRecognitionsRepository(f.sql) };
}
it("persists page transcription once, with attribution, and rejects a different owner or version", async () => {
  const x = await seed();
  expect(await x.repo.read(x.scope, x.identity)).toBeNull();
  await x.repo.save(x.scope, x.identity, x.record);
  await x.repo.save(x.scope, x.identity, { ...x.record, result: { ...x.record.result, transcription: "do not overwrite" } });
  expect(await x.repo.read(x.scope, x.identity)).toEqual(x.record);
  await expect(x.repo.read({ ...x.scope, ownerUserId: f.otherScope.ownerUserId }, x.identity)).rejects.toMatchObject({ code: "CONFLICT" });
  await f.sql`UPDATE opening_sources SET version=1 WHERE id=${x.identity.sourceId}`;
  await expect(x.repo.read(x.scope, x.identity)).rejects.toMatchObject({ code: "CONFLICT" });
});
it.each(["cancel", "privacy", "lease"])("cannot persist or read under a revoked %s execution", async kind => {
  const x = await seed();
  if (kind === "cancel") await f.sql`UPDATE opening_jobs SET state='cancelled' WHERE id=${x.jobId}`;
  if (kind === "privacy") await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${x.scope.workspaceId}`;
  if (kind === "lease") await f.sql`UPDATE opening_jobs SET claim_token=${randomUUID()} WHERE id=${x.jobId}`;
  await expect(x.repo.save(x.scope, x.identity, x.record)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(x.repo.read(x.scope, x.identity)).rejects.toMatchObject({ code: "CONFLICT" });
});
it("rejects malformed model output and removes derivative cache with its original source", async () => {
  const x = await seed();
  await expect(x.repo.save(x.scope, x.identity, { ...x.record, result: { ...x.record.result, transcription: "\f rac{x}" } })).rejects.toThrow();
  await x.repo.save(x.scope, x.identity, x.record);
  await f.sql`DELETE FROM opening_sources WHERE id=${x.identity.sourceId}`;
  expect(await f.sql`SELECT * FROM opening_source_visual_recognitions WHERE source_id=${x.identity.sourceId}`).toHaveLength(0);
});
it("passes the sealed question's original visual page to grading alongside its recognized text", async () => {
  const attempt = await learningAttemptFixture(f);
  await f.sql`UPDATE opening_source_chunks SET image_object_key='original' WHERE id=${attempt.chunkId}`;
  const answer = await attempt.submit(await attempt.start(), { outcome: "unverified" });
  const context = await createOpeningAiGradingRepository(f.sql).context(f.scope, { observationId: answer.id });
  expect(context.referenceSources).toEqual([{ sourceId: attempt.sourceId, sourceVersion: context.sourceVersions[attempt.sourceId], physicalPage: 1 }]);
});
it("keeps citation chunk identities when replaying an identical recognized source revision", async () => {
  const x = await seed(), chunks = createOpeningSourceChunksRepository(f.sql);
  const input = { sourceId: x.identity.sourceId, sourceVersion: 0, chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null,
    text: x.record.result.transcription, imageObjectKey: x.record.imageObjectKey }] };
  await chunks.replaceChunks(x.scope, input);
  const initial = await chunks.listChunks(x.scope, input.sourceId);
  await chunks.replaceChunks(x.scope, input);
  expect(await chunks.listChunks(x.scope, input.sourceId)).toEqual(initial);
});
