import { expect, it } from "vitest";
import { systemQueryResultSchema } from "@aistudy/contracts";
import { createSystemQueryRoute } from "./system-query-routing";
const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002";
const clock = { today: "2026-10-19", timeZone: "UTC" };
it.each([undefined, a])("rejects a model-filtered course id B before a read (bound=%s)", courseId => {
  const route = createSystemQueryRoute("我现在学到哪里", clock, { courseId });
  expect(route.admit({ name: "courses", arguments: { courseId: b, limit: 5, offset: 0 } })).toBeNull();
  expect(route.admit({ name: "learning", arguments: { courseId: b, limit: 5, offset: 0 } })).toBeNull();
});
it.each([{ status: "partial", nextOffset: 1, offset: 0 }, { status: "ok", nextOffset: null, offset: 1 }] as const)("does not approve one source in an incomplete candidate set (%s)", state => {
  const route = createSystemQueryRoute("材料“原文关键词”在哪页", clock);
  const result = systemQueryResultSchema.parse({ name: "materials", authorization: { purpose: "system_record_lookup", workspaceId: a, principalId: a, role: "workspace_owner", permissionRevision: "owner" },
    status: state.status, reason: state.status === "ok" ? "read" : "truncated", asOf: "2026-10-19T00:00:00Z", version: "1", evidence: [], nextOffset: state.nextOffset,
    sourceRefs: [{ sourceId: b, sourceVersion: 1 }], data: [{ id: a, sourceId: b, sourceVersion: 1, physicalPage: 1, truncated: false, exposure: "content_withheld", summary: "candidate" }] });
  route.observe(result, { name: "materials", arguments: { query: "原文关键词", limit: 1, offset: state.offset } });
  expect(route.admit({ name: "materials", arguments: { sourceId: b, limit: 5, offset: 0 } })).toBeNull();
  expect(route.clarification).toBeTruthy();
});
it("accepts an explicit user course id and refuses invented material narrowing", () => {
  expect(createSystemQueryRoute(`查询课程${b}的学习进度`, clock).admit({ name: "courses", arguments: { courseId: b, limit: 5, offset: 0 } })).not.toBeNull();
  for (const arguments_ of [{ query: "原文", physicalPage: 2 }, { query: "原文", sourceVersion: 1 }, { query: "文" }]) {
    expect(createSystemQueryRoute("材料“原文”在哪页", clock).admit({ name: "materials", arguments: { ...arguments_, limit: 5, offset: 0 } })).toBeNull();
  }
});
