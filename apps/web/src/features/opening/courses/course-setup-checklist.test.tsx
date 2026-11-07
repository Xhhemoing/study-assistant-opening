// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CourseRouteRequirementInput } from "@aistudy/contracts";
import { CourseSetupChecklist } from "./course-setup-checklist";
import type { CourseKnowledgeRecord, KnowledgeRebuildClient } from "../knowledge/knowledge-rebuild-client";

const courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", sourceId = "11111111-1111-4111-8111-111111111111", goalId = "22222222-2222-4222-8222-222222222222";
const suggestion: CourseRouteRequirementInput = { id: sourceId, stableSkillId: sourceId, knowledgeNodeId: null, requirementKey: "concept-one", title: "概念一", position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [], verification: { kind: "manual", status: "needs_check", exerciseKeys: [], rubric: "独立解释概念", missingReasons: [] }, origin: "extracted" };
type Props = ComponentProps<typeof CourseSetupChecklist>;
const incomplete: Props["snapshot"] = { scopeState: "missing", suggestions: [suggestion], summary: { total: 0, mandatory: 0, verified: 0, blocked: 0 }, materials: [{ sourceId, sourceVersion: 1, title: "讲义", available: true }, { sourceId, sourceVersion: 2, title: "教材", available: false }] };
const complete: Props["snapshot"] = { scopeState: "confirmed", suggestions: [], summary: { total: 3, mandatory: 3, verified: 0, blocked: 0 }, materials: [{ sourceId, sourceVersion: 1, title: "讲义", available: true }] };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function record(nodes: number): CourseKnowledgeRecord {
  return { version: 1, sourceVersions: {}, snapshot: { courseId, version: 1, edges: [], nodes: Array.from({ length: nodes }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, courseId, label: `知识点${index}`, kind: "concept" as const, evidenceChunkIds: [], status: "suggested" as const })) } };
}
function knowledge(nodes: number): KnowledgeRebuildClient { return { read: vi.fn(async () => record(nodes)), rebuild: vi.fn() }; }
function props(patch: Partial<Props> = {}): Props {
  return { courseId, snapshot: incomplete, goals: [{ id: goalId, title: "期末复习" }], goalId: "", goalsUnavailable: false, goalsHref: "?tab=overview#course-goals", knowledgeClient: knowledge(0), onReviewScope: vi.fn(), onKnowledgeRebuilt: vi.fn(), ...patch };
}
async function render(value: Props) { await act(async () => root.render(<CourseSetupChecklist {...value} />)); return value; }
function items() { return [...host.querySelectorAll("li")]; }
function item(title: string) { const node = items().find(row => row.querySelector("p")?.firstChild?.textContent === title); if (!node) throw new Error(`missing ${title}`); return node; }
function control(scope: Element, text: string) { const node = [...scope.querySelectorAll<HTMLElement>("a, button")].find(entry => entry.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }

it("marks every unfinished setup step and points each one at its own next place", async () => {
  const value = await render(props());
  expect(items().map(row => row.querySelector("p")?.firstChild?.textContent)).toEqual(["资料已解析", "知识已整理", "已选目标", "范围已确认"]);
  expect(items().every(row => row.textContent?.includes("未完成"))).toBe(true);
  expect(item("资料已解析").textContent).toContain("1/2 份资料已解析可用");
  expect(control(item("资料已解析"), "去资料页").getAttribute("href")).toBe("?tab=materials#course-assets");
  expect(item("知识已整理").textContent).toContain("还没有整理出知识点");
  expect((control(item("知识已整理"), "整理知识点") as HTMLButtonElement).disabled).toBe(false);
  expect(item("已选目标").textContent).toContain("在下方“本次路线目标”中选择一个目标。");
  expect(control(item("已选目标"), "去目标与成功标准").getAttribute("href")).toBe("?tab=overview#course-goals");
  expect(item("范围已确认").textContent).toContain("已整理出 1 项要求建议");
  await act(async () => control(item("范围已确认"), "去确认全课范围").click());
  expect(value.onReviewScope).toHaveBeenCalledTimes(1);
});

it("marks every step done from parsed materials, a non-empty knowledge graph, the selected goal and the confirmed scope", async () => {
  await render(props({ snapshot: complete, goalId, knowledgeClient: knowledge(3) }));
  expect(items().every(row => row.textContent?.includes("已完成"))).toBe(true);
  expect(item("资料已解析").textContent).toContain("1 份资料都已解析可用。");
  expect(item("知识已整理").textContent).toContain("已整理出 3 个知识点。");
  expect(item("已选目标").textContent).toContain("本次路线目标：期末复习");
  expect(item("范围已确认").textContent).toContain("已确认 3 项课程要求。");
  expect(host.textContent).not.toContain("去资料页");
  expect(host.textContent).not.toContain("去目标与成功标准");
  expect(host.textContent).not.toContain("去确认全课范围");
  expect(control(item("知识已整理"), "重新整理知识点")).toBeTruthy();
});

const incompleteCases: Array<[string, Partial<Props>, string, string]> = [
  ["no materials", { snapshot: { ...incomplete, materials: [] } }, "资料已解析", "还没有课程资料，先上传讲义或教材。"],
  ["an unreadable knowledge graph", { knowledgeClient: { read: vi.fn(async () => { throw new Error("offline"); }), rebuild: vi.fn() } }, "知识已整理", "整理结果暂不可读取"],
  ["unreadable goals", { goals: null, goalsUnavailable: true }, "已选目标", "目标暂不可读取，请重新读取课程路线。"],
  ["no goal linked to the course", { goals: [] }, "已选目标", "还没有关联本课程的目标，先去创建一个。"],
  ["unconfirmed requirements", { snapshot: { ...incomplete, scopeState: "unconfirmed" } }, "范围已确认", "有课程要求尚未确认"],
];
it.each(incompleteCases)("keeps the step incomplete with %s", async (_label, patch, title, detail) => {
  await render(props(patch));
  expect(item(title).textContent).toContain("未完成");
  expect(item(title).textContent).toContain(detail);
});

it("re-reads the knowledge graph when the route reloads and skips it for archived courses", async () => {
  const client = knowledge(0);
  const value = await render(props({ knowledgeClient: client }));
  expect(client.read).toHaveBeenCalledTimes(1);
  await render({ ...value, reloadToken: 1 });
  expect(client.read).toHaveBeenCalledTimes(2);

  await act(async () => root.unmount());
  root = createRoot(host);
  const archived = knowledge(2);
  await render(props({ archived: true, knowledgeClient: archived }));
  expect(archived.read).not.toHaveBeenCalled();
  expect(item("知识已整理").textContent).toContain("课程已归档，恢复课程后可整理知识点。");
  expect(host.querySelector("li button")).toBeNull();
});
