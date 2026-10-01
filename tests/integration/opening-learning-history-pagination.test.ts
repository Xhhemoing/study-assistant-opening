import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { observationRevisionInputSchema } from "@aistudy/contracts";
import { readOpeningCourseLearningHistory } from "../../packages/database/src/repositories/opening-learning-history-read";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";
import { insertOpeningLearningObservation } from "../../packages/database/src/repositories/opening-learning-observations";
import { createOpeningSourceActionsRepository } from "../../packages/database/src/repositories/opening-source-actions";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`;
  await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
});
afterAll(async () => { await fixture?.close(); });
const page = (courseId: string, extra = {}) => readOpeningCourseLearningHistory(fixture.sql, fixture.scope, { courseId, limit: 50, ...extra });
async function submit(f: Awaited<ReturnType<typeof learningAttemptFixture>>, extra = {}) {
  return f.learning.insertObservation(fixture.scope, { sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions",
    sourceIds: [f.sourceId], answer: "1", outcome: "correct", assistance: "independent", clientKey: randomUUID(), ...extra });
}
const replacement = (root: string, head = root, changes = {}) => observationRevisionInputSchema.parse({
  rootObservationId: root, revisesObservationId: head, expectedHead: head, revisionKind: "replace", reason: "Correct attribution", clientKey: randomUUID(),
  replacement: { answer: "2", outcome: "incorrect", assistance: "independent", ...changes },
});

it("requires explicit stored watermarks and allocates a positive revision for each new fact", async () => {
  const f = await learningAttemptFixture(fixture), original = await submit(f);
  expect(await page(f.courseId)).toMatchObject({ snapshotRevision: 1, totalCount: 1, nextCursor: null });
  const revised = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, replacement(original.id));
  const rows = await fixture.sql`SELECT id,workspace_history_revision FROM opening_learning_observations
    WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY workspace_history_revision`;
  expect(rows.map(row => [row.id, Number(row.workspace_history_revision)])).toEqual([[original.id, 1], [revised.headObservationId, 2]]);
  const [column] = await fixture.sql`SELECT column_default,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='opening_learning_observations' AND column_name='workspace_history_revision'`;
  expect(column).toMatchObject({ column_default: null, is_nullable: "NO" });
});

it("returns an empty page and the newest 50 of 201 roots without truncating the continuation", async () => {
  const f = await learningAttemptFixture(fixture);
  expect(await page(f.courseId)).toMatchObject({ observations: [], totalCount: 0, nextCursor: null, visibilityChanged: false });
  const ids: string[] = [];
  for (let index = 0; index < 201; index++) ids.push((await submit(f)).id);
  const first = await page(f.courseId);
  expect(first.observations.map(row => row.id)).toEqual(ids.slice(-50).reverse());
  expect(first.totalCount).toBe(201);
  expect((await page(f.courseId, { limit: 200 })).observations).toHaveLength(200);
  const last = await page(f.courseId, { cursor: first.nextCursor, limit: 200 });
  expect(last.observations.map(row => row.id)).toEqual(ids.slice(0, -50).reverse());
  expect(last).toMatchObject({ snapshotRevision: first.snapshotRevision, totalCount: 201, nextCursor: null, visibilityChanged: false });
}, 30_000);

it("keeps R-local heads and course membership while new observations and cross-course corrections commit", async () => {
  const f = await learningAttemptFixture(fixture), other = await learningAttemptFixture(fixture);
  const oldest = await submit(f), newest = await submit(f);
  const first = await page(f.courseId, { limit: 1 });
  expect(first.observations[0]?.id).toBe(newest.id);
  const changed = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, replacement(oldest.id, oldest.id, { courseId: other.courseId }));
  await submit(f);
  const continuation = await page(f.courseId, { cursor: first.nextCursor, limit: 1 });
  expect(continuation.observations).toMatchObject([{ id: oldest.id, effectiveHeadId: oldest.id, courseId: f.courseId }]);
  expect(continuation.totalCount).toBe(2);
  expect((await page(f.courseId)).observations.map(row => row.id)).not.toContain(oldest.id);
  expect((await page(other.courseId)).observations.map(row => row.id)).toEqual([changed.headObservationId]);
  const movedFirst = await page(other.courseId);
  await reviseOpeningLearningObservation(fixture.sql, fixture.scope, replacement(oldest.id, changed.headObservationId, { courseId: f.courseId }));
  expect(movedFirst.observations[0]?.effectiveHeadId).toBe(changed.headObservationId);
  expect((await page(other.courseId)).observations).toHaveLength(0);
});

it("orders equal-millisecond roots by database microseconds and retains the exact cursor boundary", async () => {
  const f = await learningAttemptFixture(fixture), roots = [await submit(f), await submit(f), await submit(f)].sort((a, b) => a.id.localeCompare(b.id));
  for (const [index, root] of roots.entries()) {
    await fixture.sql`UPDATE opening_learning_observations SET occurred_at=${`2026-09-30T12:00:00.12345${6 - index}Z`}::text::timestamptz WHERE id=${root.id}`;
  }
  const first = await page(f.courseId, { limit: 1 });
  const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
  expect(decoded.occurredAt).toBe("2026-09-30T12:00:00.123456Z");
  const second = await page(f.courseId, { cursor: first.nextCursor, limit: 1 });
  const third = await page(f.courseId, { cursor: second.nextCursor, limit: 1 });
  expect([first, second, third].map(result => result.observations[0]?.id)).toEqual(roots.map(row => row.id));
  expect(third.nextCursor).toBeNull();
});

it("filters after selecting heads, preserves all/null/empty requirements, and includes retractions", async () => {
  const f = await learningAttemptFixture(fixture), root = await submit(f), plain = await submit(f);
  const first = await page(f.courseId, { requirementKey: null, limit: 1 });
  const empty = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, replacement(root.id, root.id, { requirementKey: "" }));
  expect((await page(f.courseId, { requirementKey: null })).observations.map(row => row.id)).toEqual([plain.id]);
  expect((await page(f.courseId, { requirementKey: "" })).observations.map(row => row.id)).toEqual([empty.headObservationId]);
  expect((await page(f.courseId)).totalCount).toBe(2);
  expect((await page(f.courseId, { requirementKey: null, cursor: first.nextCursor, limit: 1 })).observations[0]?.id).toBe(root.id);
  const retraction = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, observationRevisionInputSchema.parse({
    rootObservationId: root.id, expectedHead: empty.headObservationId, revisesObservationId: empty.headObservationId,
    revisionKind: "retract", reason: "Withdraw mistaken record", clientKey: randomUUID(),
  }));
  expect((await page(f.courseId, { requirementKey: "" })).observations).toMatchObject([{ id: retraction.headObservationId, revisionKind: "retract" }]);
});

it("uses predecessor links for legacy zero-watermark chains without resurrecting an old course", async () => {
  const f = await learningAttemptFixture(fixture), other = await learningAttemptFixture(fixture), root = await submit(f);
  const revised = await reviseOpeningLearningObservation(fixture.sql, fixture.scope, replacement(root.id, root.id, { courseId: other.courseId }));
  await fixture.sql`UPDATE opening_learning_observations SET workspace_history_revision=0 WHERE workspace_id=${fixture.scope.workspaceId}`;
  await fixture.sql`UPDATE opening_workspace_history_revisions SET revision=0 WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect(await page(f.courseId)).toMatchObject({ snapshotRevision: 0, observations: [], totalCount: 0 });
  expect((await page(other.courseId)).observations.map(row => row.id)).toEqual([revised.headObservationId]);
});

it("applies current whole-chain privacy before count/limit and accepts a now-hidden boundary", async () => {
  const f = await learningAttemptFixture(fixture), oldest = await submit(f, { sourceIds: [] }), middle = await submit(f, { sourceIds: [] }), newest = await submit(f);
  const first = await page(f.courseId, { limit: 1 });
  expect(first.observations[0]?.id).toBe(newest.id);
  await reviseOpeningLearningObservation(fixture.sql, fixture.scope, replacement(middle.id, middle.id, { referenceSourceId: f.sourceId }));
  await fixture.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${fixture.scope.workspaceId},${f.sourceId})`;
  const continuation = await page(f.courseId, { cursor: first.nextCursor, limit: 1 });
  expect(continuation.observations.map(row => row.id)).toEqual([oldest.id]);
  expect(continuation).toMatchObject({ totalCount: 1, visibilityChanged: true, nextCursor: null, snapshotRevision: first.snapshotRevision });
  expect((await page(f.courseId)).observations.map(row => row.id)).toEqual([oldest.id]);
});

it("rejects foreign scope, filter changes, malformed cursors, future revisions and fabricated boundaries", async () => {
  const f = await learningAttemptFixture(fixture), other = await learningAttemptFixture(fixture);
  await submit(f); await submit(f);
  const first = await page(f.courseId, { limit: 1 }), raw = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
  const altered = (change: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...raw, ...change })).toString("base64url");
  for (const cursor of ["x", "%%%", "a".repeat(2049), altered({ snapshotRevision: first.snapshotRevision + 1 }),
    altered({ rootId: randomUUID() }), altered({ occurredAt: "2026-01-01T00:00:00.000000Z" }), altered({ extra: true })]) {
    await expect(page(f.courseId, { cursor })).rejects.toThrow();
  }
  await expect(page(other.courseId, { cursor: first.nextCursor })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(page(f.courseId, { cursor: first.nextCursor, requirementKey: null })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(readOpeningCourseLearningHistory(fixture.sql, fixture.otherScope, { courseId: f.courseId, limit: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(readOpeningCourseLearningHistory(fixture.sql, fixture.otherScope, { courseId: f.courseId, cursor: first.nextCursor!, limit: 1 })).rejects.toMatchObject({ code: "VALIDATION" });
});

it("signals a committed privacy change even when the fixed course visible count stays the same", async () => {
  const f = await learningAttemptFixture(fixture), other = await learningAttemptFixture(fixture);
  await submit(f); await submit(f);
  const first = await page(f.courseId, { limit: 1 });
  await createOpeningSourceActionsRepository(fixture.sql).apply(fixture.scope, other.sourceId,
    { action: "exclude", expectedVersion: 1, expectedMembershipIds: [] },
    { stagingKey: id => `opening/sources/${id}/staging`, finalKey: (id, version) => `opening/sources/${id}/${version}` }, new Date());
  const continuation = await page(f.courseId, { cursor: first.nextCursor, limit: 1 });
  expect(continuation.totalCount).toBe(first.totalCount);
  expect(continuation.visibilityChanged).toBe(true);
});

function pausedCommit(sql: Sql, rollback = false) {
  let release: () => void = () => undefined, entered: () => void = () => undefined;
  const paused = new Promise<void>(resolve => { entered = resolve; }), resumed = new Promise<void>(resolve => { release = resolve; });
  const proxy = new Proxy(sql, { get(target, key, receiver) {
    if (key !== "begin") return Reflect.get(target, key, receiver);
    return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      const result = await callback(tx); entered(); await resumed;
      if (rollback) throw new Error("deliberate history rollback");
      return result;
    });
  } });
  return { sql: proxy, paused, release: () => release() };
}

it("serializes actual writers while a third connection reads old committed R, and rollback/replay do not advance it", async () => {
  const f = await learningAttemptFixture(fixture), other = await learningAttemptFixture(fixture);
  const oldest = await submit(f); await submit(f);
  const before = await page(f.courseId, { limit: 1 });
  const a = openRaceSession(), b = openRaceSession(), reader = openRaceSession();
  await Promise.all([a.ready, b.ready, reader.ready]);
  const hold = pausedCommit(a.sql), pending: Promise<unknown>[] = [];
  const input = { sessionId: f.sessionId, courseId: f.courseId, skillLabel: "fractions", sourceIds: [f.sourceId],
    answer: "1", outcome: "correct" as const, assistance: "independent" as const, clientKey: randomUUID() };
  try {
    const firstWrite = track(insertOpeningLearningObservation(hold.sql, fixture.scope, input)); pending.push(firstWrite);
    await hold.paused;
    const secondWrite = track(insertOpeningLearningObservation(b.sql, fixture.scope, { ...input, sessionId: other.sessionId,
      courseId: other.courseId, sourceIds: [other.sourceId], clientKey: randomUUID() })); pending.push(secondWrite);
    await waitUntilBlocked(fixture.sql, b.pid, a.pid, "second workspace fact", /opening_workspace_history_revisions/);
    const during = await readOpeningCourseLearningHistory(reader.sql, fixture.scope, { courseId: f.courseId, limit: 1 });
    expect(during.snapshotRevision).toBe(before.snapshotRevision);
    expect(during.totalCount).toBe(2);
    hold.release(); await Promise.all([firstWrite, secondWrite]);
    const continuation = await page(f.courseId, { cursor: during.nextCursor, limit: 1 });
    expect(continuation.observations.map(row => row.id)).toEqual([oldest.id]);
    expect((await page(f.courseId)).snapshotRevision).toBe(before.snapshotRevision + 2);
    await insertOpeningLearningObservation(fixture.sql, fixture.scope, input);
    expect((await page(f.courseId)).snapshotRevision).toBe(before.snapshotRevision + 2);
    const aborted = pausedCommit(a.sql, true);
    const rollback = track(insertOpeningLearningObservation(aborted.sql, fixture.scope, { ...input, clientKey: randomUUID() })); pending.push(rollback);
    try { await aborted.paused; } finally { aborted.release(); }
    await expect(rollback).rejects.toThrow("deliberate history rollback");
    expect(await page(f.courseId)).toMatchObject({ snapshotRevision: before.snapshotRevision + 2, totalCount: 3 });
  } finally {
    hold.release(); await Promise.allSettled(pending);
    await Promise.all([closeRace(a.sql), closeRace(b.sql), closeRace(reader.sql)]);
  }
}, 20_000);
