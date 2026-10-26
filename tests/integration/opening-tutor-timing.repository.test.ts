import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOpeningConversationRepository, createOpeningTutorJobsRepository, recordOpeningTutorTiming } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import type { Sql } from "postgres";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });

async function timingTarget() {
  const conversations = createOpeningConversationRepository(fixture.sql), jobs = createOpeningTutorJobsRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "Timing timeout", courseId: null });
  const submitted = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
    text: "Explain", mode: "explain", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  const claim = await jobs.claim(submitted.jobId);
  return { jobId: submitted.jobId, executionId: claim!.executionId!, claimToken: claim!.claimToken!,
    kind: "tutor_first_text" as const, observedAt: new Date(), durationMs: 1 };
}

it("bounds a timing lock wait and releases its workspace lock before business completion", async () => {
  const input = await timingTarget();
  let unlock!: () => void, locked!: () => void;
  const hold = new Promise<void>(resolve => { unlock = resolve; }), acquired = new Promise<void>(resolve => { locked = resolve; });
  const blocker = fixture.sql.begin(async tx => {
    await tx`SELECT id FROM opening_tutor_jobs WHERE id=${input.jobId} FOR UPDATE`;
    locked(); await hold;
  });
  await acquired;
  const recording = recordOpeningTutorTiming(fixture.sql, fixture.scope, input).then(value => ({ value }), error => ({ error }));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([recording, new Promise<{ timeout: true }>(resolve => { deadline = setTimeout(() => resolve({ timeout: true }), 1000); })]);
    expect(result).toMatchObject({ error: { code: "55P03" } });
    const businessStarted = performance.now();
    await fixture.sql.begin(async tx => {
      await tx`SET LOCAL statement_timeout = '1000ms'`;
      await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE`;
    });
    expect(performance.now() - businessStarted).toBeLessThan(1000);
  } finally { if (deadline) clearTimeout(deadline); unlock(); await blocker; await recording; }
});

it("limits a slow statement within the real timing transaction", async () => {
  const input = await timingTarget();
  const delayed = { begin: (body: (tx: Sql) => Promise<unknown>) => fixture.sql.begin(async tx => {
    const proxy = new Proxy(tx, { apply: async (target, receiver, args) => {
      if (String(args[0]).includes("SELECT id FROM workspaces")) await tx`SELECT pg_sleep(0.3)`;
      return Reflect.apply(target, receiver, args);
    } });
    return body(proxy as unknown as Sql);
  }) } as unknown as Sql;
  await expect(recordOpeningTutorTiming(delayed, fixture.scope, input)).rejects.toMatchObject({ code: "57014" });
});

it("releases locks when a timing client stalls between SQL statements", async () => {
  const input = await timingTarget();
  let resume!: () => void, ownerHeld!: () => void;
  const wait = new Promise<void>(resolve => { resume = resolve; }), acquired = new Promise<void>(resolve => { ownerHeld = resolve; });
  const delayed = { begin: (body: (tx: Sql) => Promise<unknown>) => fixture.sql.begin(async tx => {
    const proxy = new Proxy(tx, { apply: async (target, receiver, args) => {
      if (String(args[0]).includes("WITH current_execution")) { ownerHeld(); await wait; }
      return Reflect.apply(target, receiver, args);
    } });
    return body(proxy as unknown as Sql);
  }) } as unknown as Sql;
  const recording = recordOpeningTutorTiming(delayed, fixture.scope, input).then(value => ({ value }), error => ({ error }));
  try {
    await acquired;
    const businessStarted = performance.now();
    await fixture.sql.begin(async tx => {
      await tx`SET LOCAL statement_timeout = '1000ms'`;
      await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE`;
    });
    expect(performance.now() - businessStarted).toBeLessThan(1000);
    resume();
    expect(await recording).toHaveProperty("error");
  } finally { resume(); await recording; }
});

it("claims one durable execution and rejects duplicate, unrelated and expired timing writes", async () => {
  const conversations = createOpeningConversationRepository(fixture.sql), jobs = createOpeningTutorJobsRepository(fixture.sql);
  const conversation = await conversations.create(fixture.scope, { title: "Timing", courseId: null });
  const submitted = await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
    text: "Explain", mode: "explain", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  const claim = await jobs.claim(submitted.jobId);
  expect(claim?.executionId).toBeTruthy();
  expect(claim?.executionId).not.toBe(claim?.claimToken);
  expect(await jobs.claim(submitted.jobId)).toBeNull();
  const [claimed] = await fixture.sql`SELECT * FROM opening_learning_experience_events
    WHERE target_id=${submitted.jobId} AND kind='tutor_claimed'`;
  expect(claimed.execution_id).toBe(claim!.executionId); expect(claimed.observed_at).toBeTruthy();
  const [workspace] = await fixture.sql`SELECT privacy_epoch FROM workspaces WHERE id=${fixture.scope.workspaceId}`;
  await expect(jobs.readStream(fixture.scope, submitted.jobId, { privacyEpoch: Number(workspace.privacy_epoch),
    contextSourceRefs: [], exposureReceiptId: null, claimToken: claim!.claimToken, executionId: randomUUID(),
  })).rejects.toThrow("stream execution changed");
  const input = { jobId: submitted.jobId, executionId: claim!.executionId!, claimToken: claim!.claimToken!,
    kind: "tutor_first_text" as const, observedAt: new Date(), durationMs: 0 };
  expect(await recordOpeningTutorTiming(fixture.sql, fixture.otherScope, input)).toEqual({ recorded: false });
  expect(await recordOpeningTutorTiming(fixture.sql, fixture.scope, { ...input, executionId: randomUUID() })).toEqual({ recorded: false });
  expect(await recordOpeningTutorTiming(fixture.sql, fixture.scope, { ...input, claimToken: randomUUID() })).toEqual({ recorded: false });
  expect(await recordOpeningTutorTiming(fixture.sql, fixture.scope, input)).toEqual({ recorded: true });
  expect(await recordOpeningTutorTiming(fixture.sql, fixture.scope, { ...input, durationMs: 999 })).toEqual({ recorded: false });
  await fixture.sql`UPDATE opening_tutor_jobs SET status='queued' WHERE id=${submitted.jobId}`;
  const nextClaim = await jobs.claim(submitted.jobId);
  expect(nextClaim!.executionId).not.toBe(claim!.executionId);
  expect(await recordOpeningTutorTiming(fixture.sql, fixture.scope, { ...input, kind: "tutor_first_chunk" })).toEqual({ recorded: false });
  expect(await recordOpeningTutorTiming(fixture.sql, fixture.scope, { ...input, claimToken: nextClaim!.claimToken!, kind: "tutor_first_chunk" })).toEqual({ recorded: false });
  expect(await recordOpeningTutorTiming(fixture.sql, fixture.scope, { ...input, executionId: nextClaim!.executionId!, claimToken: nextClaim!.claimToken!, kind: "tutor_first_chunk" })).toEqual({ recorded: true });
  const [stored] = await fixture.sql`SELECT duration_ms FROM opening_learning_experience_events
    WHERE target_id=${submitted.jobId} AND kind='tutor_first_text'`;
  expect(stored.duration_ms).toBe(0);
});
