import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { runBudgetedCall, type ModelGatewayCallOptions } from "@aistudy/ai";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningSourceRepository, createOpeningTranscriptionCheckpointsRepository } from "@aistudy/database";
import { createModelTranscribeAdapter } from "../../apps/worker/src/parsers/model-transcribe-adapter";
import { scopeBudget } from "../../apps/worker/src/runtime/model-gateway";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
let dir: string;
beforeAll(async () => { f = await createOpeningFixture(); dir = await mkdtemp(path.join(os.tmpdir(), "transcription-recovery-")); });
beforeEach(async () => { await f.reset(); });
afterAll(async () => { await f?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const sourceId = randomUUID();
  await f.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${f.scope.workspaceId}, 'audio.wav', 'audio/wav', 10, ${'a'.repeat(64)}, 1, 'uploaded', 'running')`;
  const jobs = createOpeningJobRepository(f.sql);
  const job = await jobs.createOnce(f.scope, { key: randomUUID(), kind: 'parse-media', payload: { sourceId, sourceVersion: 1 }, privacyEpoch: 0 });
  await jobs.claim(job.id);
  const repo = createOpeningTranscriptionCheckpointsRepository(f.sql);
  const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 });
  const provider = vi.fn(async () => ({ text: JSON.stringify({ segments: [{ startMs: 0, endMs: 900, text: 'spoken' }] }),
    citedChunkIds: [], candidates: [], requestId: null, inputTokens: 10, outputTokens: 10 }));
  const input = { path: '/tmp/input.wav', mime: 'audio/wav', sourceId, sourceVersion: 1, hasAudio: true, durationMs: 601_000 };
  let failThirdConversion = false;
  let failSettlement = false;
  const bound = scopeBudget(budget, f.scope);
  const run = vi.fn(async (_binary: string, argv: string[]) => {
    if (failThirdConversion && argv.includes('600')) throw new Error('third conversion failed');
    await writeFile(argv.at(-1)!, 'RIFF-audio');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const makeAdapter = (jobId: string) => createModelTranscribeAdapter({ scope: f.scope, jobId, tempDir: dir, run, budget: {
    ...bound, settle: async (...args) => { if (failSettlement) throw new Error('settlement connection lost'); return bound.settle(...args); },
  }, gateway: { call: async (_scope, _task, options: ModelGatewayCallOptions) => runBudgetedCall({
    ...options, requestId: options.operationId, purpose: 'transcribe', provider: { complete: provider }, reservedCents: 100, actualCents: () => 1,
  }) }, checkpoints: {
    load: chunk => repo.recover(f.scope, { ...chunk, jobId, privacyEpoch: 0 }, budget),
    save: (chunk, output, receipt) => repo.save(f.scope, { ...chunk, jobId, privacyEpoch: 0 }, { output, ...receipt }),
  } });
  const adapter = makeAdapter(job.id);
  async function manualRetry() {
    await jobs.finish(job.id, 'failed', { message: 'parse failed' });
    const key = `parse:${sourceId}:retry:${randomUUID()}`;
    await createOpeningSourceRepository(f.sql).retryParseWithJob(f.scope, sourceId, {
      key, payload: { sourceId, sourceVersion: 1 }, privacyEpoch: 0,
    });
    const [retried] = await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND key=${key}`;
    await jobs.claim(retried!.id);
    return makeAdapter(retried!.id);
  }
  return { sourceId, job, jobs, repo, budget, provider, input, adapter, run,
    manualRetry,
    setFailThird: (value: boolean) => { failThirdConversion = value; },
    setFailSettlement: (value: boolean) => { failSettlement = value; } };
}
const signal = new AbortController().signal;

it('restarts at the missing third chunk and never settles completed chunks twice', async () => {
  const s = await setup(); s.setFailThird(true);
  await expect(s.adapter(s.input, signal)).rejects.toThrow('third conversion failed');
  expect(s.provider).toHaveBeenCalledTimes(2);
  s.setFailThird(false); s.run.mockClear();
  const result = await s.adapter(s.input, signal);
  expect(s.provider).toHaveBeenCalledTimes(3);
  expect(s.run).toHaveBeenCalledTimes(1);
  expect(result.map(row => [row.startMs, row.endMs, row.text])).toEqual([[0, 900, 'spoken'], [300000, 300900, 'spoken'], [600000, 600900, 'spoken']]);
  const [ledger] = await f.sql`SELECT count(*)::int n, sum(amount_cents)::int amount FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  expect(ledger).toEqual({ n: 3, amount: 3 });
  expect(await s.adapter(s.input, signal)).toEqual(result);
  expect(s.provider).toHaveBeenCalledTimes(3);
});

it('reuses settled chunks when the Inbox retry creates a new parse job', async () => {
  const s = await setup(); s.setFailThird(true);
  await expect(s.adapter(s.input, signal)).rejects.toThrow('third conversion failed');
  const retry = await s.manualRetry(); s.setFailThird(false); s.run.mockClear();
  expect(await retry(s.input, signal)).toHaveLength(3);
  expect(s.provider).toHaveBeenCalledTimes(3);
  expect(s.run).toHaveBeenCalledTimes(1);
  const [ledger] = await f.sql`SELECT count(*)::int n, sum(amount_cents)::int amount FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  expect(ledger).toEqual({ n: 3, amount: 3 });
});

it('does not resend an unknown call under the manually retried job id', async () => {
  const s = await setup(); s.provider.mockRejectedValue(new Error('provider response lost'));
  await expect(s.adapter(s.input, signal)).rejects.toThrow('provider response lost');
  const retry = await s.manualRetry();
  await expect(retry(s.input, signal)).rejects.toThrow('previous transcription outcome is unresolved');
  expect(s.provider).toHaveBeenCalledTimes(1);
});

it('recovers a receipt saved before settlement crashed without another provider request', async () => {
  const s = await setup(); s.setFailSettlement(true);
  const input = { ...s.input, durationMs: 1000 };
  await expect(s.adapter(input, signal)).rejects.toThrow('settlement connection lost');
  s.setFailSettlement(false);
  await expect(s.adapter(input, signal)).resolves.toHaveLength(1);
  expect(s.provider).toHaveBeenCalledTimes(1);
  const [row] = await f.sql`SELECT state, amount_cents, result_ref FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`;
  expect(row).toEqual({ state: 'completed', amount_cents: 1, result_ref: `transcribe:${s.job.id}:0` });
});

it('does not resend after a provider outcome is unknown and no receipt exists', async () => {
  const s = await setup(); s.provider.mockRejectedValue(new Error('provider response lost'));
  await expect(s.adapter(s.input, signal)).rejects.toThrow('provider response lost');
  await expect(s.adapter(s.input, signal)).rejects.toThrow('budget replay: unknown');
  expect(s.provider).toHaveBeenCalledTimes(1);
});

it.each(['version', 'privacy', 'cancelled', 'foreign'] as const)('refuses saved results after the %s boundary changes', async change => {
  const s = await setup(); const input = { ...s.input, durationMs: 1000 };
  await s.adapter(input, signal);
  if (change === 'version') await f.sql`UPDATE opening_sources SET version=2 WHERE id=${s.sourceId}`;
  if (change === 'privacy') await f.sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${f.scope.workspaceId}`;
  if (change === 'cancelled') await s.jobs.cancel(f.scope, s.job.id);
  if (change === 'foreign') {
    await expect(s.repo.recover(f.otherScope, { jobId: s.job.id, sourceId: s.sourceId, sourceVersion: 1, privacyEpoch: 0, index: 0, offsetMs: 0, durationMs: 1000 }, s.budget)).rejects.toThrow();
  } else await expect(s.adapter(input, signal)).rejects.toThrow('state changed');
  expect(s.provider).toHaveBeenCalledTimes(1);
  if (change === 'privacy') await f.sql`UPDATE workspaces SET privacy_epoch=0 WHERE id=${f.scope.workspaceId}`;
});
