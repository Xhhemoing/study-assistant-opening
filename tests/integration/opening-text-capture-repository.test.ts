import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningSourceActionsRepository, OpeningS3 } from "@aistudy/database";
import { POST } from "../../apps/web/src/app/api/opening/imports/text/route";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
vi.mock("../../apps/web/src/features/opening/runtime", () => ({
  requireOpeningScope: async () => ({ sql: f.sql, scope: f.scope, principal: {
    userId: f.scope.ownerUserId, workspaceId: f.scope.workspaceId, sessionId: "capture-test",
  } }),
}));

let courseA: string, courseB: string;
const post = (courseId: string | null, scheduleNextDayRetell = false, content = "Original", providerHint?: string) =>
  POST(new Request("http://localhost/api/opening/imports/text", { method: "POST",
    body: JSON.stringify({ clientKey: "one-capture", title: "Notes", content, providerHint, courseId, scheduleNextDayRetell }) }));

beforeEach(async () => {
  f = await createOpeningFixture();
  courseA = randomUUID();
  courseB = randomUUID();
  await f.sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES
    (${courseA}, ${f.scope.workspaceId}, 'A', 'a'), (${courseB}, ${f.scope.workspaceId}, 'B', 'b')`;
  const objects = new Map<string, Uint8Array>();
  const store = OpeningS3.prototype;
  vi.spyOn(store, "putObject").mockImplementation(async (key, bytes) => { objects.set(key, bytes); });
  vi.spyOn(store, "headObject").mockImplementation(async key => ({
    exists: objects.has(key), bytes: objects.get(key)?.length ?? 0, etag: "test", mime: "text/markdown",
  }));
  vi.spyOn(store, "streamDigest").mockImplementation(async key => {
    const bytes = objects.get(key)!;
    return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), firstBytes: bytes };
  });
  vi.spyOn(store, "copyStagingToFinal").mockImplementation(async (from, to) => { objects.set(to, objects.get(from)!); });
  vi.spyOn(store, "deleteObject").mockImplementation(async key => { objects.delete(key); });
});
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });

it.each([true, false])("binds a pending and completed source-only capture to its original course (withCourse=%s)", async withCourse => {
  const original = withCourse ? courseA : null;
  // Pause the winning request after its reservation commits, before object storage acknowledges it.
  let signalEntry!: () => void, allowUpload!: () => void;
  const entered = new Promise<void>(resolve => { signalEntry = resolve; });
  const resume = new Promise<void>(resolve => { allowUpload = resolve; });
  const put = vi.mocked(OpeningS3.prototype.putObject);
  const store = put.getMockImplementation()!;
  put.mockImplementationOnce(async (key, bytes) => {
    signalEntry();
    await resume;
    await store(key, bytes);
  });
  const winner = post(original);
  try {
    await Promise.race([entered, winner.then(response => {
      throw new Error(`Reservation returned HTTP ${response.status} before staging`);
    })]);
    expect((await post(courseB)).status).toBe(409);
    expect((await post(original, true)).status).toBe(409);
    expect((await post(original, false, "Modified")).status).toBe(409);
  } finally {
    allowUpload();
  }
  const created = await winner;
  expect(created.status).toBe(201);
  const { sourceId } = await created.json();
  expect((await post(withCourse ? courseA.toUpperCase() : null)).status).toBe(200);
  expect((await post(courseB)).status).toBe(409);
  expect((await post(withCourse ? null : courseA)).status).toBe(409);
  expect((await post(original, false, "Modified")).status).toBe(409);
  expect(put).toHaveBeenCalledTimes(1);
  expect(await f.sql`SELECT course_id FROM course_asset_memberships WHERE asset_id=${sourceId}`)
    .toEqual(withCourse ? [{ course_id: original }] : []);
});

it("replays when the winning request deletes staging after the other read the pending source", async () => {
  const head = vi.mocked(OpeningS3.prototype.headObject);
  const read = head.getMockImplementation()!;
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  head.mockImplementationOnce(async key => {
    entered();
    await resume;
    const object = await read(key);
    expect(object.exists).toBe(false);
    return object;
  });
  const concurrent = post(courseA, true);
  let created;
  try {
    await Promise.race([paused, concurrent.then(r => { throw new Error(`Unexpected HTTP ${r.status} before HEAD`); })]);
    const winner = await post(courseA, true);
    expect(winner.status).toBe(201);
    created = await winner.json();
  } finally {
    release();
  }
  const replay = await concurrent;
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(created);
});

it("keeps a missing staging object as a validation error while the source is still pending", async () => {
  vi.mocked(OpeningS3.prototype.headObject).mockResolvedValueOnce({ exists: false, bytes: 0, etag: "", mime: "" });
  expect((await post(courseA)).status).toBe(400);
  expect(await f.sql`SELECT upload_state FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`)
    .toEqual([{ upload_state: "pending" }]);
});

it("distinguishes a provider hint from identical text pasted into the body", async () => {
  expect((await post(null, false, "Original", "chatgpt")).status).toBe(201);
  expect((await post(null, false, "Original\n\n讲解来源：ChatGPT")).status).toBe(409);
  expect((await post(null, false, "Original", "chatgpt")).status).toBe(200);
  expect(OpeningS3.prototype.putObject).toHaveBeenCalledTimes(1);
});

it.each([true, false])("replays a completed archived course and refuses incomplete repairs (retell=%s)", async retell => {
  const created = await post(courseA, retell);
  expect(created.status).toBe(201);
  const result = await created.json();
  await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseA}`;
  const replay = await post(courseA, retell);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  if (retell) {
    await f.sql`DELETE FROM opening_tasks WHERE id=${result.taskId}`;
    expect((await post(courseA, retell)).status).toBe(404);
    expect(await f.sql`SELECT id FROM opening_tasks WHERE id=${result.taskId}`).toHaveLength(0);
  } else {
    await f.sql`DELETE FROM course_asset_memberships WHERE asset_id=${result.sourceId}`;
    expect((await post(courseA, retell)).status).toBe(404);
    expect(await f.sql`SELECT id FROM course_asset_memberships WHERE asset_id=${result.sourceId}`).toHaveLength(0);
  }
});

it("fails closed when a pre-migration capture has no recorded course intent", async () => {
  const created = await post(courseA);
  expect(created.status).toBe(201);
  const { sourceId } = await created.json();
  await f.sql`UPDATE opening_sources SET text_capture_intent=NULL WHERE id=${sourceId}`;
  expect((await post(courseB)).status).toBe(409);
  expect((await post(null)).status).toBe(409);
  expect(await f.sql`SELECT course_id FROM course_asset_memberships WHERE asset_id=${sourceId}`).toEqual([{ course_id: courseA }]);
});

it.each([true, false])("permanent deletion and cleanup retain the capture key (retell=%s)", async retell => {
  const created = await post(courseA, retell);
  expect(created.status).toBe(201);
  const { sourceId } = await created.json();
  const actions = createOpeningSourceActionsRepository(f.sql);
  const impact = await actions.impact(f.scope, sourceId);
  const removed = await actions.apply(f.scope, sourceId, { action: "delete", expectedVersion: impact.version,
    expectedMembershipIds: impact.courses.map(c => c.membershipId) }, {
    stagingKey: id => `staging/${id}`, finalKey: (id, version) => `opening/sources/${id}/v${version}`,
  }, new Date());
  for (const key of removed.cleanup.keys) await actions.cleaned(f.scope, sourceId, key);
  for (const course of [courseA, courseB, null]) {
    for (const flag of [retell, !retell]) expect((await post(course, flag)).status).toBe(409);
  }
  expect(await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toEqual([]);
  expect(await f.sql`SELECT course_id FROM course_asset_memberships WHERE asset_id=${sourceId}`).toEqual([]);
  expect(OpeningS3.prototype.putObject).toHaveBeenCalledTimes(1);
});
