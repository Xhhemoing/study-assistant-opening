import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOpeningExamPublicSource } from "../../packages/database/src/repositories/opening-exam-public-source";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture, sourceId: string;
const sections = ["公开串讲\n\n课程概述", "例题与讲解", "下一节课"], text = sections.join("\n\n");
beforeAll(async () => {
  f = await createOpeningFixture();
  const courseId = randomUUID(), sprintId = randomUUID(); sourceId = randomUUID();
  const bytes = Buffer.byteLength(text, "utf8"), sha = createHash("sha256").update(text).digest("hex");
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Exam course',${courseId})`;
  await f.sql`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,pack_snapshot,state)
    VALUES(${sprintId},${f.scope.workspaceId},${f.scope.ownerUserId},'{}'::jsonb,'{}'::jsonb)`;
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${f.scope.workspaceId},'Public lessons','text/plain',${bytes},${sha},0,'uploaded','ready')`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES(${sourceId},0,${f.scope.workspaceId},${bytes},${sha},'available')`;
  // Deliberately insert in reverse order; physical page order is the document order.
  for (let i = sections.length - 1; i >= 0; i--) {
    await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${sourceId},0,${i + 1},${sections[i]!})`;
  }
  await f.sql`INSERT INTO opening_exam_bindings(sprint_id,course_id,binding)
    VALUES(${sprintId},${courseId},${f.sql.json({ packSourceId: sourceId })})`;
});
afterAll(async () => {
  if (!f) return;
  await f.sql`DELETE FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_source_versions WHERE workspace_id=${f.scope.workspaceId}`;
  await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.close();
});

describe("bound public exam source repository", () => {
  it("requires the actual owned binding and reconstructs the exact version-zero document in page order", async () => {
    expect(await readOpeningExamPublicSource(f.sql, f.scope, sourceId, 0)).toEqual({ text, bytes: Buffer.byteLength(text, "utf8") });
    expect(await readOpeningExamPublicSource(f.sql, f.otherScope, sourceId, 0)).toBeNull();
    expect(await readOpeningExamPublicSource(f.sql, { ...f.scope, ownerUserId: f.otherScope.ownerUserId }, sourceId, 0)).toBeNull();
    expect(await readOpeningExamPublicSource(f.sql, f.scope, randomUUID(), 0)).toBeNull();
    expect(await readOpeningExamPublicSource(f.sql, f.scope, sourceId, 1)).toBeNull();
  });
  it("refuses changed chunks and unavailable version metadata", async () => {
    await f.sql`UPDATE opening_source_chunks SET text='Changed' WHERE source_id=${sourceId} AND page=2`;
    await expect(readOpeningExamPublicSource(f.sql, f.scope, sourceId, 0)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`UPDATE opening_source_chunks SET text=${sections[1]!} WHERE source_id=${sourceId} AND page=2`;
    await f.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${sourceId}`;
    await expect(readOpeningExamPublicSource(f.sql, f.scope, sourceId, 0)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
