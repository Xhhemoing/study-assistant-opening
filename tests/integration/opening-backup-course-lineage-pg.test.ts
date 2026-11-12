import { afterEach, beforeEach, expect, it } from "vitest";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";
import { createCourseLineagePgFixture, originalVerification, type CourseLineagePgFixture } from "./opening-backup-course-lineage-pg-fixture";

let f: CourseLineagePgFixture;
beforeEach(async () => { f = await createCourseLineagePgFixture(); });
afterEach(async () => { await f?.dispose(); });

const unavailable = {
  title: "材料不可用的课程要求", knowledge_node_id: null, approved_at: null,
  verification: { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null,
    missingReasons: ["此要求部分材料未包含在备份中，请补充可读材料并重新确认要求与验证标准。"] },
};

it.each([
  ["JSON null", null], ["object without array", {}], ["scalar", "source-free is not a string"],
  ["null entry", [null]], ["missing sourceId", [{ sourceVersion: 1 }]],
  ["non-string sourceId", [{ sourceId: 23 }]], ["nested array", [[]]],
])("redacts the complete persisted %s lineage through the public inventory", async (_label, malformed) => {
  const id = await f.requirement(malformed);
  // A single bad entry invalidates the whole lineage, even alongside a good ref.
  const mixed = await f.requirement([f.includedRef, null]);
  const before = await f.stored();
  if (malformed === null) {
    const [stored] = await f.sql`SELECT source_refs IS NULL AS sql_null, jsonb_typeof(source_refs) AS json_type
      FROM course_requirements WHERE id=${id}`;
    expect(stored).toEqual({ sql_null: false, json_type: "null" });
  }
  const snapshot = await readOpeningBackupRecords(f.reader, f.scope);
  expect(snapshot.tables.opening_sources.map(row => row.id)).toEqual([f.included]);
  expect(snapshot.tables.course_asset_memberships.map(row => row.asset_id)).toEqual([f.included]);
  expect(snapshot.tables.course_requirements).toHaveLength(2);
  for (const key of [id, mixed]) {
    const original = before.find(row => row.id === key)!;
    expect(snapshot.tables.course_requirements.find(row => row.id === key)).toEqual({
      ...original, ...unavailable, source_refs: [],
    });
  }
  expect(await f.stored()).toEqual(before);
});

it("keeps [] and the actual omitted-column default; SQL NULL cannot enter the migrated schema", async () => {
  const empty = await f.requirement([]), omitted = await f.requirement([], true);
  const before = await f.stored();
  await expect(f.sql`UPDATE course_requirements SET source_refs=NULL WHERE id=${empty}`)
    .rejects.toMatchObject({ code: "23502", column_name: "source_refs" });
  const snapshot = await readOpeningBackupRecords(f.reader, f.scope);
  expect(snapshot.tables.course_requirements).toEqual(before);
  for (const id of [empty, omitted]) {
    expect(snapshot.tables.course_requirements.find(row => row.id === id)).toMatchObject({
      source_refs: [], verification: originalVerification, title: "原始要求 https://example.invalid/title#原文",
    });
  }
  expect(await f.stored()).toEqual(before);
});

it("filters to the real uploaded nonexcluded workspace inventory, retaining metadata, order, IDs and denominator", async () => {
  const keptRefs = [f.includedRef, { ...f.includedRef, page: 9 }, f.includedRef] as const;
  const all = await f.requirement(keptRefs);
  const partial = await f.requirement([keptRefs[0], {sourceId: f.excluded}, keptRefs[1],
    {sourceId: f.uploading}, {sourceId: f.foreignSource}, keptRefs[2]]);
  const foreign = await f.requirement([{sourceId: f.foreignSource}]);
  const before = await f.stored();
  const snapshot = await readOpeningBackupRecords(f.reader, f.scope);
  expect(snapshot.privacyEpoch).toBe(1);
  expect(snapshot.deletionJournal.map(row => row.sourceId)).toEqual([f.excluded]);
  expect(snapshot.tables.opening_sources.map(row => row.id)).toEqual([f.included]);
  expect(snapshot.tables.courses.map(row => row.id)).toEqual([f.course]);
  expect(snapshot.tables.course_asset_memberships.map(row => row.asset_id)).toEqual([f.included]);
  expect(snapshot.tables.course_requirements).toHaveLength(before.length);
  expect(snapshot.tables.course_requirements.find(row => row.id === all)).toEqual(before.find(row => row.id === all));
  expect(snapshot.tables.course_requirements.find(row => row.id === partial)).toEqual({
    ...before.find(row => row.id === partial), ...unavailable, source_refs: keptRefs,
  });
  expect(snapshot.tables.course_requirements.find(row => row.id === foreign)).toEqual({
    ...before.find(row => row.id === foreign), ...unavailable, source_refs: [],
  });
  expect(snapshot.tables.course_requirements.some(row => row.id === f.foreignRequirement)).toBe(false);
  expect(await f.stored()).toEqual(before);
});

it("rejects both crossed workspace/owner scopes and performs no writes with a SELECT-only role", async () => {
  await f.requirement([f.includedRef]);
  const before = await f.stored();
  for (const scope of [
    { ...f.scope, ownerUserId: f.otherScope.ownerUserId },
    { ...f.otherScope, ownerUserId: f.scope.ownerUserId },
  ]) await expect(readOpeningBackupRecords(f.reader, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(f.reader`UPDATE course_requirements SET title='unexpected' WHERE workspace_id=${f.scope.workspaceId}`)
    .rejects.toMatchObject({ code: "42501" });
  const snapshot = await readOpeningBackupRecords(f.reader, f.scope);
  expect(snapshot.tables.course_requirements).toEqual(before);
  expect(await f.stored()).toEqual(before);
});

it("uses one real repeatable-read snapshot for owner epoch, source inventory and requirement projection", async () => {
  const id = await f.requirement([f.includedRef]);
  const before = await f.stored();
  const holder = await openRaceSession().ready;
  const [backend] = await f.reader<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
  if (!backend) throw new Error("Reader backend PID missing");
  const { pid } = backend;
  let release = () => undefined as void, opened = () => undefined as void;
  const unlocked = new Promise<void>(resolve => { release = resolve; });
  const gate = new Promise<void>(resolve => { opened = resolve; });
  const lock = track(holder.sql.begin(async tx => {
    await tx`LOCK TABLE course_requirements IN ACCESS EXCLUSIVE MODE`;
    opened();
    await unlocked;
  }));
  let pending: ReturnType<typeof readOpeningBackupRecords> | undefined;
  try {
    await Promise.race([gate, lock]);
    pending = track(readOpeningBackupRecords(f.reader, f.scope));
    await waitUntilBlocked(f.sql, pid, holder.pid, "course requirement snapshot", /FROM course_requirements/);
    await f.rows.exclude(f.included);
    release();
    await lock;
    const snapshot = await pending;
    expect(snapshot.privacyEpoch).toBe(1);
    expect(snapshot.tables.opening_sources.map(row => row.id)).toEqual([f.included]);
    expect(snapshot.tables.course_requirements).toEqual(before);
    const current = await readOpeningBackupRecords(f.reader, f.scope);
    expect(current.privacyEpoch).toBe(2);
    expect(current.tables.opening_sources).toEqual([]);
    expect(current.tables.course_asset_memberships).toEqual([]);
    expect(current.tables.course_requirements.find(row => row.id === id)).toEqual({
      ...before[0], ...unavailable, source_refs: [],
    });
    expect(await f.stored()).toEqual(before);
  } finally {
    release();
    await Promise.allSettled([lock, ...(pending ? [pending] : [])]);
    await closeRace(holder.sql);
  }
}, 15_000);
