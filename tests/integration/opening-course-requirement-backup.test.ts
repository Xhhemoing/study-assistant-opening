import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { readOpeningBackupCourseRecords } from "../../packages/database/src/repositories/opening-backup-course-records";
import { validateBackupLearningGoals } from "@aistudy/domain";
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
it("preserves the course denominator and prerequisite identities when source-derived content is excluded", async () => {
  const rows = backupRows(f.sql, f.scope), publicSource = await rows.source(), privateSource = await rows.source();
  const course = randomUUID(), a = randomUUID(), b = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${course},${f.scope.workspaceId},'Backup scope',${course})`;
  for (const [id, sourceId, prerequisites] of [[a, publicSource, [b]], [b, privateSource, []]] as const) {
    await f.sql`INSERT INTO course_requirements(id,workspace_id,owner_user_id,course_id,stable_skill_id,requirement_key,title,
      prerequisite_ids,source_refs,verification,approved_at) VALUES(${id},${f.scope.workspaceId},${f.scope.ownerUserId},${course},${randomUUID()},${id},
      ${id === b ? 'private-derived-title' : 'public-title'},${[...prerequisites]},${f.sql.json([{ sourceId, sourceVersion: 1 }])},
      ${f.sql.json({ kind: 'rubric', status: 'ready', exerciseKeys: [], rubric: 'private-derived-standard', missingReasons: [] })},now())`;
  }
  const snapshot = await f.sql.begin(tx => readOpeningBackupCourseRecords(tx, f.scope.workspaceId, [publicSource]));
  expect(snapshot.course_requirements).toHaveLength(2);
  const kept = snapshot.course_requirements.find(row => row.id === a)!;
  const redacted = snapshot.course_requirements.find(row => row.id === b)!;
  expect(kept.prerequisite_ids).toEqual([b]);
  expect(redacted).toMatchObject({ title: "材料不可用的课程要求", approved_at: null, source_refs: [], verification: { status: "missing", rubric: null } });
  const errors: string[] = [];
  validateBackupLearningGoals({ ...snapshot, opening_sources: [{ id: publicSource, workspace_id: f.scope.workspaceId }] }, errors, f.scope.ownerUserId);
  expect(errors).toEqual([]);
});
