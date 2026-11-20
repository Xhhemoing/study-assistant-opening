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
const post = (courseId: string | null, scheduleNextDayRetell = false, content = "Original") =>
  POST(new Request("http://localhost/api/opening/imports/text", { method: "POST",
    body: JSON.stringify({ clientKey: "one-capture", title: "Notes", content, courseId, scheduleNextDayRetell }) }));

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
    exists: objects.has(key), bytes: objects.get(key)!.length, etag: "test", mime: "text/markdown",
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
