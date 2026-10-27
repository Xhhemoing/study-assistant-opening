// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { LearningLinkTargetForm, type LearningLinkTarget } from "./learning-link-target-form";
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222", g = "33333333-3333-4333-8333-333333333333";
vi.mock("../courses/learning-goal-client", () => ({ createLearningGoalClient: () => ({ courses: async () => [{ id: a, title: "A课" }, { id: b, title: "B课" }], list: async () => ({ goals: [{ id: g, title: "A课目标", revision: 4 }] }) }) }));
vi.mock("../courses/course-route-client", () => ({ createCourseRouteClient: () => ({ read: async () => ({ requirements: [{ requirement: { id: g, title: "A课要求", revision: 3, goalIds: [g] } }] }) }) }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(value: LearningLinkTarget) { const onChange = vi.fn(); await act(async () => root.render(<LearningLinkTargetForm value={value} onChange={onChange} />)); return onChange; }
it("keeps no-course and no-goal an explicit usable selection without auto-selecting a goal", async () => { const changed = await render({ courseId: null, goalId: null, requirementId: null }); expect((host.querySelector('select') as HTMLSelectElement).value).toBe(""); expect(changed).not.toHaveBeenCalled(); expect(host.textContent).toContain("独立使用"); });
it("clears a previous goal and requirement when explicitly moving to another course", async () => { const changed = await render({ courseId: a, goalId: g, expectedGoalRevision: 4, requirementId: g, expectedRequirementRevision: 3 }); const select = host.querySelector('select') as HTMLSelectElement; await act(async () => { select.value = b; select.dispatchEvent(new Event("change", { bubbles: true })); }); expect(changed).toHaveBeenCalledExactlyOnceWith({ courseId: b, goalId: null, requirementId: null }); });
it("captures the actual current formal goal revision on explicit selection", async () => { const changed = await render({ courseId: a, goalId: null, requirementId: null }); const select = host.querySelectorAll('select')[1]!; await act(async () => { select.value = g; select.dispatchEvent(new Event("change", { bubbles: true })); }); expect(changed).toHaveBeenCalledExactlyOnceWith({ courseId: a, goalId: g, expectedGoalRevision: 4, requirementId: null }); });
