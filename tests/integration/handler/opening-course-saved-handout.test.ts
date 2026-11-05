import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createLibraryRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { loadCourseHandout } from "../../../apps/web/src/features/opening/courses/server/course-handout";
import { CourseHandoutReader } from "../../../apps/web/src/features/opening/courses/course-handout-reader";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "../opening-fixture";
import { backupRows } from "../opening-backup-records-fixture";

let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!, sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
  vi.stubEnv("OPENING_TEACHING_LOOP", "1");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://opening.local" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterAll(async () => { setAuthRuntimeForTests(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await runtime?.close(); await f?.close(); });
const request = () => new Request("http://opening.local/handout", { headers: { cookie: f.cookie } });
async function workspaceContents() {
  const tables = await f.sql`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id' ORDER BY table_name`;
  const result: Record<string, unknown> = {};
  for (const table of tables) result[String(table.table_name)] = await f.sql`SELECT to_jsonb(t) AS row FROM ${f.sql(String(table.table_name))} t WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId}) ORDER BY to_jsonb(t)::text`;
  return JSON.stringify(result);
}
async function seed() {
  const courseId = randomUUID(), rows = backupRows(f.sql, f.scope), sourceId = await rows.source("uploaded", 1), chunkId = await rows.chunk(sourceId, 1);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL,text='只读正文材料' WHERE id=${chunkId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'只读课程',${courseId})`;
  const activityId = await insertTestTeachingActivity(f.sql, f.scope, courseId);
  const blocks = [
    { id: randomUUID(), type: "text", content: { text: "只读正文", citedChunkIds: [chunkId] } },
    { id: randomUUID(), type: "prompt", content: { text: "计算二加三？" } },
    { id: randomUUID(), type: "answer_key", content: { text: "秘密答案五" } },
    { id: randomUUID(), type: "prompt", content: { text: "没有参考答案的题干？" } },
  ];
  const repo = createOpeningTeachingContentRepository(f.sql), unit = await repo.createUnit(f.scope, { title: "讲义", blocks });
  await repo.publishActivitySpec(f.scope, { activityId, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: 1, verificationStatus: "needs_check", sourceRefs: [{ sourceId, version: 1, chunkId, page: 1 }], blockOrder: blocks.map((b, position) => ({ blockId: b.id, blockType: b.type, position, role: b.type === "answer_key" ? "answer_key" : b.type === "prompt" ? "prompt" : "teach" })) });
  await f.sql`UPDATE opening_teaching_activities SET generate_status='needs_check' WHERE id=${activityId}`;
  return { courseId, activityId, sourceId, unit, blocks };
}
it("reads authenticated PG → loader → real DOM, including archived/completed and paused, without writes or answer exposure", async () => {
  const x = await seed();
  await createLibraryRepository(f.sql).updateDocument({ workspaceId: f.scope.workspaceId, documentId: x.unit.documentId, expectedRevisionNumber: 1, blocks: x.blocks.map(b => ({ ...b, content: { ...b.content, text: "未采用的新版本" } })) });
  for (const status of ["active", "completed", "paused"]) {
    await f.sql`UPDATE opening_teaching_activities SET status=${status} WHERE id=${x.activityId}`;
    if (status !== "active") await f.sql`UPDATE courses SET archived_at=now() WHERE id=${x.courseId}`;
    const before = await workspaceContents(), data = await loadCourseHandout(request(), x.courseId, x.activityId);
    expect(data).not.toBeNull();
    expect(JSON.stringify(data)).not.toContain("秘密答案五");
    const host = document.createElement("div"), root = createRoot(host);
    try {
      await act(async () => root.render(createElement(CourseHandoutReader, data!)));
      for (const text of ["只读讲义", "待核对", "只读正文", "计算二加三？", "没有参考答案的题干？", "本段依据", x.sourceId]) expect(host.textContent).toContain(text);
      for (const text of ["秘密答案五", "未采用的新版本", "已掌握", "已核验", "预计"]) expect(host.textContent).not.toContain(text);
      expect(host.querySelector("input,textarea,select,button,form")).toBeNull();
      expect(host.querySelector('a')?.getAttribute("href")).toBe(`/opening/courses/${x.courseId}?tab=units`);
    } finally { await act(async () => root.unmount()); }
    expect(await workspaceContents()).toBe(before);
  }
});
it("refuses invalid identity, foreign owner/course, unavailable generation/spec, feature gate and unavailable historical material without writes", async () => {
  const x = await seed(), foreign = await insertTestTeachingActivity(f.sql, f.otherScope);
  let before = await workspaceContents();
  for (const [courseId, activityId] of [[randomUUID(), x.activityId], [x.courseId, foreign], [x.courseId, randomUUID()], ["bad", x.activityId], [x.courseId, "bad"]]) expect(await loadCourseHandout(request(), courseId!, activityId!)).toBeNull();
  expect(await loadCourseHandout(new Request("http://opening.local/handout"), x.courseId, x.activityId)).toBeNull();
  expect(await workspaceContents()).toBe(before);
  for (const status of ["failed", "queued", "unknown"]) {
    await f.sql`UPDATE opening_teaching_activities SET generate_status=${status} WHERE id=${x.activityId}`;
    before = await workspaceContents();
    expect(await loadCourseHandout(request(), x.courseId, x.activityId)).toBeNull();
    expect(await workspaceContents()).toBe(before);
  }
  await f.sql`UPDATE opening_teaching_activities SET generate_status='ready' WHERE id=${x.activityId}`;
  vi.stubEnv("OPENING_TEACHING_LOOP", "0");
  expect(await loadCourseHandout(request(), x.courseId, x.activityId)).toBeNull();
  vi.stubEnv("OPENING_TEACHING_LOOP", "1");
  await f.sql`UPDATE opening_sources SET version=2 WHERE id=${x.sourceId}`;
  before = await workspaceContents();
  expect(await loadCourseHandout(request(), x.courseId, x.activityId)).toBeNull();
  expect(await workspaceContents()).toBe(before);
  const noSpec = await insertTestTeachingActivity(f.sql, f.scope, x.courseId);
  await f.sql`UPDATE opening_teaching_activities SET generate_status='ready',content_version=1 WHERE id=${noSpec}`;
  before = await workspaceContents();
  expect(await loadCourseHandout(request(), x.courseId, noSpec)).toBeNull();
  expect(await workspaceContents()).toBe(before);
});
