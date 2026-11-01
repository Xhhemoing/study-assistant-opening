// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { CourseRouteRequirementInput, CourseRouteSnapshot } from "@aistudy/contracts";
import { CourseRoutePanel, parsePhysicalPages } from "./course-route-panel";
import type { CourseRouteClient } from "./course-route-client";
const id = "11111111-1111-4111-8111-111111111111", courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const requirement: CourseRouteRequirementInput = { id, stableSkillId: id, knowledgeNodeId: null, requirementKey: "concept-one", title: "概念一", position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [], verification: { kind: "manual", status: "needs_check", exerciseKeys: [], rubric: "独立解释概念", missingReasons: [] }, origin: "confirmed" };
const snapshot: CourseRouteSnapshot = { courseId, scopeState: "unconfirmed", requirements: [], suggestions: [requirement], summary: { total: 0, mandatory: 0, verified: 0, blocked: 0 }, materials: Array.from({ length: 33 }, (_, index) => ({ sourceId: id, sourceVersion: index, title: `资料 ${index + 1}`, available: true })), currentActivity: null, currentRoute: null, observationId: null };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function client(value = snapshot): CourseRouteClient { return { read: vi.fn(async () => value), confirm: vi.fn(async () => ({ ...value, scopeState: "confirmed" as const })), start: vi.fn(), next: vi.fn(), scheduleRetest: vi.fn(), task: vi.fn(), verification: vi.fn(), confirmVerification: vi.fn() }; }
function button(text: string) { const node = [...host.querySelectorAll("button")].find(item => item.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }
async function render(api: CourseRouteClient) { await act(async () => root.render(<CourseRoutePanel courseId={courseId} client={api} goalsClient={{ list: vi.fn(async () => ({ goals: [], selectedGoalIds: {}, legacyConflicts: [] })) }} />)); }
it("shows the full material inventory while keeping extracted suggestions unconfirmed", async () => { const api = client(); await render(api); expect(host.textContent).toContain("资料 33"); expect(host.textContent).toContain("尚未确认全课范围"); expect(api.confirm).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled(); });
it("confirms the explicitly reviewed full list without replacing stable identities", async () => { const api = client(); await render(api); await act(async () => button("检查与确认课程范围").click()); expect(host.textContent).toContain("概念一"); await act(async () => button("确认这份全课范围").click()); expect(api.confirm).toHaveBeenCalledWith(courseId, { expectedRevisions: [], requirements: [requirement], confirmScope: true }); });
it("keeps material and verification gaps visible and does not claim course mastery", async () => { const row = { requirement: { ...requirement, courseId, revision: 1, lifecycle: "active" as const, approvedAt: null }, status: "blocked" as const, observationId: null, sourcesAvailable: false, missingReasons: ["缺少可用题目"] }; await render(client({ ...snapshot, scopeState: "confirmed", suggestions: [], requirements: [row], summary: { total: 1, mandatory: 1, verified: 0, blocked: 1 } })); expect(host.textContent).toContain("缺少可用题目"); expect(host.textContent).toContain("资料不可用"); expect(host.textContent).not.toContain("已掌握"); });
it("does not mount an editable empty scope after a failed read", async () => { const api = client(); vi.mocked(api.read).mockRejectedValue(new Error("offline")); await render(api); expect(host.textContent).toContain("重新读取课程路线"); expect(host.textContent).not.toContain("确认这份全课范围"); });


it.each(["network", "timeout"])("does not discard scope confirmation after %s and retry rejection", async mode => { sessionStorage.clear(); const { CourseRouteRequestError } = await import("./course-route-client"); const api = client(); vi.mocked(api.confirm).mockRejectedValueOnce(mode === "timeout" ? new CourseRouteRequestError("请求超时", 408) : new TypeError("lost")).mockRejectedValueOnce(new CourseRouteRequestError("请核对", 409)); await render(api); await act(async () => button("检查与确认课程范围").click()); await act(async () => button("确认这份全课范围").click()); const original = vi.mocked(api.confirm).mock.calls[0]; await act(async () => button("重新确认这次安排").click()); expect(host.textContent).toContain("安排结果尚未确认"); await act(async () => button("重新确认这次安排").click()); expect(vi.mocked(api.confirm).mock.calls[2]).toEqual(original); });

it("keeps current verification and an expired delayed check separate", async () => { const row = { requirement: { ...requirement, courseId, revision: 1, lifecycle: "active" as const, approvedAt: null }, status: "verified" as const, observationId: null, sourcesAvailable: true, missingReasons: [], delayedCheck: { status: "expired" as const, retestId: id, taskId: id, notBeforeAt: "2026-10-30T00:00:00Z" } }; await render(client({ ...snapshot, scopeState: "confirmed", suggestions: [], requirements: [row], summary: { total: 1, mandatory: 1, verified: 1, blocked: 0 } })); expect(host.textContent).toContain("已有验证记录"); expect(host.textContent).toContain("原复测已过期"); expect(host.textContent).not.toContain("长期掌握"); });
it.each([["", []], ["3,4,3", [3, 4]] as const])("parses valid physical pages %s", (value, expected) => { expect(parsePhysicalPages(value)).toEqual(expected); });
it.each(["0", "-1", "3,,4", "3,a"])("rejects invalid physical pages %s", value => { expect(parsePhysicalPages(value)).toBeNull(); });
it("submits selected pages and an unscoped selected material through the client", async () => {
  const materialB = "22222222-2222-4222-8222-222222222222";
  const api = client({ ...snapshot, materials: [{ ...snapshot.materials[0], title: "资料 A" }, { ...snapshot.materials[1], sourceId: materialB, title: "资料 B" }], suggestions: [{ ...requirement, sourceRefs: [] }] });
  await render(api);
  await act(async () => button("检查与确认课程范围").click());
  const materialChecks = [...host.querySelectorAll('input[type="checkbox"]')].filter(input => (input.parentElement?.textContent ?? "").startsWith("资料 ")) as HTMLInputElement[];
  await act(async () => { materialChecks[0].click(); materialChecks[1].click(); });
  const pageInput = host.querySelector('input[aria-label="资料 A物理页"]') as HTMLInputElement;
  await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(pageInput, "3,4,3"); pageInput.dispatchEvent(new Event("input", { bubbles: true })); pageInput.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("确认这份全课范围").click());
  expect(api.confirm).toHaveBeenCalledWith(courseId, { expectedRevisions: [], requirements: [{ ...requirement, sourceRefs: [{ sourceId: materialB, sourceVersion: 1 }, { sourceId: id, sourceVersion: 0, page: 3 }, { sourceId: id, sourceVersion: 0, page: 4 }] }], confirmScope: true });
});
