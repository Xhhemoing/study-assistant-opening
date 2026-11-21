import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningSourceActionsRepository, OpeningS3, OpeningStorageError } from "@aistudy/database";
import { POST as startTeaching } from "../../apps/web/src/app/api/opening/teaching-activities/route";
import { POST } from "../../apps/web/src/app/api/opening/imports/text/route";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
vi.mock("../../apps/web/src/features/opening/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("../../apps/web/src/features/opening/runtime")>(),
  requireOpeningScope: async () => ({ sql: f.sql, scope: f.scope, principal: {
    userId: f.scope.ownerUserId, workspaceId: f.scope.workspaceId, sessionId: "capture-test",
  } }),
}));

let courseA: string, courseB: string;
const post = (courseId: string | null, scheduleNextDayRetell = false, content = "Original", providerHint?: string, timeZone?: string) =>
  POST(new Request("http://localhost/api/opening/imports/text", { method: "POST",
    body: JSON.stringify({ clientKey: "one-capture", title: "Notes", content, providerHint, courseId, scheduleNextDayRetell, timeZone }) }));

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

it.each([true, false])("cleans a late staging write and reports only the completing request as created (retell=%s)", async retell => {
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const put = vi.mocked(OpeningS3.prototype.putObject);
  const write = put.getMockImplementation()!;
  let stagingKey = "";
  put.mockImplementationOnce(async (key, bytes) => { stagingKey = key; entered(); await resume; await write(key, bytes); });
  const late = post(courseA, retell);
  try {
    await Promise.race([paused, late.then(r => { throw new Error(`Unexpected HTTP ${r.status}`); })]);
    const winner = await post(courseA, retell);
    expect(winner.status).toBe(201);
  } finally { release(); }
  expect((await late).status).toBe(200);
  expect((await OpeningS3.prototype.headObject(stagingKey)).exists).toBe(false);
});

it("recognizes a concurrent completion under the repository lock", async () => {
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const digest = vi.mocked(OpeningS3.prototype.streamDigest);
  const read = digest.getMockImplementation()!;
  digest.mockImplementationOnce(async (...args) => { const result = await read(...args); entered(); await resume; return result; });
  const late = post(courseA, true);
  try {
    await Promise.race([paused, late.then(r => { throw new Error(`Unexpected HTTP ${r.status}`); })]);
    expect((await post(courseA, true)).status).toBe(201);
  } finally { release(); }
  expect((await late).status).toBe(200);
  expect(OpeningS3.prototype.copyStagingToFinal).toHaveBeenCalledTimes(1);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
});

it("rolls back source completion and its membership when retell creation conflicts", async () => {
  const digest = vi.mocked(OpeningS3.prototype.streamDigest);
  const read = digest.getMockImplementation()!;
  digest.mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    const [source] = await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    await f.sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, origin)
      VALUES (${source!.id}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, 'existing task', 10, 'manual')`;
    return result;
  });
  expect((await post(courseA, true)).status).toBe(409);
  expect(await f.sql`SELECT upload_state, parse_state FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`)
    .toEqual([{ upload_state: "pending", parse_state: "not_started" }]);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT source_id FROM opening_source_versions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT asset_id FROM course_asset_memberships WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

it("commits membership and retell before a course is archived immediately after completion", async () => {
  const remove = vi.mocked(OpeningS3.prototype.deleteObject);
  const deleteObject = remove.getMockImplementation()!;
  remove.mockImplementationOnce(async key => {
    await deleteObject(key);
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseA}`;
  });
  const created = await post(courseA, true);
  expect(created.status).toBe(201);
  const result = await created.json();
  expect(await f.sql`SELECT asset_id FROM course_asset_memberships WHERE course_id=${courseA} AND asset_id=${result.sourceId}`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM opening_tasks WHERE id=${result.taskId} AND course_id=${courseA}`).toHaveLength(1);
  const replay = await post(courseA, true);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
});

it("rejects a changed or omitted timezone for a pending keyed retell", async () => {
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const put = vi.mocked(OpeningS3.prototype.putObject);
  const write = put.getMockImplementation()!;
  put.mockImplementationOnce(async (key, bytes) => { entered(); await resume; await write(key, bytes); });
  const original = post(courseA, true, "Original", undefined, "Etc/GMT+12");
  try {
    await Promise.race([paused, original.then(r => { throw new Error(`Unexpected HTTP ${r.status}`); })]);
    expect((await post(courseA, true, "Original", undefined, "Pacific/Kiritimati")).status).toBe(409);
    expect((await post(courseA, true)).status).toBe(409);
  } finally { release(); }
  const created = await original;
  expect(created.status).toBe(201);
  const result = await created.json();
  const retry = await post(courseA, true, "Original", undefined, "Etc/GMT+12");
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(result);
  expect(await f.sql`SELECT text_capture_intent->>'timeZone' AS zone FROM opening_sources WHERE id=${result.sourceId}`)
    .toEqual([{ zone: "Etc/GMT+12" }]);
  expect(await f.sql`SELECT id FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}
    AND not_before = ((statement_timestamp() AT TIME ZONE 'Etc/GMT+12')::date + 1)::timestamp AT TIME ZONE 'Etc/GMT+12'`)
    .toHaveLength(1);
});

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

it("recovers a lost staging object between HEAD and digest only for a completed exact capture", async () => {
  const missing = new OpeningStorageError("NOT_FOUND", "missing staging object");
  const digest = vi.mocked(OpeningS3.prototype.streamDigest);
  digest.mockRejectedValueOnce(missing);
  const pending = await post(courseA);
  expect(pending.status).toBe(404);
  expect(await pending.json()).toMatchObject({ error: { message: missing.message } });

  let winner;
  digest.mockImplementationOnce(async key => {
    const response = await post(courseA);
    expect(response.status).toBe(201);
    winner = await response.json();
    expect((await OpeningS3.prototype.headObject(key)).exists).toBe(false);
    throw missing;
  });
  const replay = await post(courseA);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(winner);
  expect(OpeningS3.prototype.copyStagingToFinal).toHaveBeenCalledTimes(1);
});

it("stops an interrupted reservation before sending any bytes on retry to an archived course", async () => {
  const put = vi.mocked(OpeningS3.prototype.putObject);
  put.mockRejectedValueOnce(new OpeningStorageError("NOT_FOUND", "staging unavailable"));
  expect((await post(courseA)).status).toBe(404);
  await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseA}`;
  put.mockClear();
  const retry = await post(courseA);
  expect(retry.status).toBe(404);
  expect(await retry.json()).toMatchObject({ error: { message: "找不到这门课程。" } });
  expect(put).not.toHaveBeenCalled();
  expect(OpeningS3.prototype.copyStagingToFinal).not.toHaveBeenCalled();
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

it("rejects course archival before the canonical copy and before a later pending retry stages bytes", async () => {
  const digest = vi.mocked(OpeningS3.prototype.streamDigest);
  const read = digest.getMockImplementation()!;
  digest.mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseA}`;
    return result;
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await post(courseA, true);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND", message: "找不到这门课程。" } });
  }
  expect(OpeningS3.prototype.putObject).toHaveBeenCalledTimes(1);
  expect(OpeningS3.prototype.copyStagingToFinal).not.toHaveBeenCalled();
  expect(await f.sql`SELECT upload_state, parse_state FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`)
    .toEqual([{ upload_state: "pending", parse_state: "not_started" }]);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT source_id FROM opening_source_versions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

it("enforces the planner's retell start window at creation and resumes an existing activity", async () => {
  const retestId = randomUUID();
  await f.sql`INSERT INTO opening_retest_activities(id,workspace_id,owner_user_id,course_id,skill_label,evidence_cycle_id,status)
    VALUES(${retestId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseA},'Recall',${randomUUID()},'accepted')`;
  const saved = await post(courseA, true);
  expect(saved.status).toBe(201);
  const { taskId } = await saved.json();
  const start = () => startTeaching(new Request("http://localhost/api/opening/teaching-activities", { method: "POST",
    body: JSON.stringify({ clientKey: `task:${taskId}`, intentKind: "goal", intentSummary: "Recall", createIntent: { taskId } }) }));
  await f.sql`UPDATE opening_tasks SET created_at=now()-interval '1 day', not_before=now()-interval '1 hour' WHERE id=${taskId}`;
  expect((await start()).status).toBe(409); // Open-ended retest, even after the stored floor.
  await f.sql`UPDATE opening_retest_activities SET status='completed', completed_at=now()-interval '1 minute' WHERE id=${retestId}`;
  await f.sql`UPDATE opening_tasks SET not_before=now()+interval '1 hour' WHERE id=${taskId}`;
  expect((await start()).status).toBe(409); // Retest closed, stored floor still in the future.
  expect(await f.sql`SELECT id FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  await f.sql`UPDATE opening_tasks SET not_before=now()-interval '1 hour' WHERE id=${taskId}`;
  const admitted = await start();
  expect(admitted.status).toBe(201);
  const activity = await admitted.json();
  await f.sql`UPDATE opening_tasks SET not_before=now()+interval '1 hour' WHERE id=${taskId}`;
  const replay = await start();
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({ id: activity.id });
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
