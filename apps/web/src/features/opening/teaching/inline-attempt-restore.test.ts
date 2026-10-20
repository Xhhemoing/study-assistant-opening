import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useId: () => "skill-id",
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? next(hooks.values[i]) : next; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useMemo: (factory: () => unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.values[i] = { value: factory(), deps };
    return (hooks.values[i] as { value: unknown }).value; },
  useEffect: (effect: () => unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.effects.push(() => {
      previous?.cleanup?.(); hooks.values[i] = { deps, cleanup: effect() }; }); },
}));
const api = vi.hoisted(() => ({ getSubmittedAttempt: vi.fn(), getAnswerKey: vi.fn(), createSession: vi.fn(), submitAttempt: vi.fn() }));
vi.mock("./activity-client", () => ({ createTeachingActivityClient: () => api }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => ({ ...api, getSummary: async () => [] }) }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => ({ getCourseKnowledge: async () => ({ snapshot: null }) }) }));
import { InlineAttemptForm, type InlineAttemptContext } from "./inline-attempt";
const id = "11111111-1111-4111-8111-111111111111";
const saved = { attempt: { id }, observation: { id, answer: "原先保存的答案", referenceCheck: { method: "comparison" }, outcome: "correct" } };
const context: InlineAttemptContext = { id, courseId: id, sourceIds: [], contentVersion: 3, status: "active", intentSummary: "练习", onCourseAssociated: vi.fn() };
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render(status: InlineAttemptContext["status"] = "active") {
  hooks.cursor = 0;
  const tree = InlineAttemptForm({ blockId: id, prompt: "题目", context: { ...context, status }, ready: true, onDraftChange: vi.fn() });
  hooks.effects.splice(0).forEach(effect => effect()); return tree;
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function unmount() { for (const value of hooks.values) (value as { cleanup?: () => void } | null)?.cleanup?.(); hooks.values = []; hooks.effects = []; }
beforeEach(() => { unmount(); vi.clearAllMocks(); api.getSubmittedAttempt.mockResolvedValue(saved); api.getAnswerKey.mockResolvedValue({ answer: "参考", referenceSourceId: id }); });
it.each(["active", "completed"] as const)("restores durable answer on fresh %s mount without replaying submission", async status => {
  expect(text(render(status))).toContain("正在恢复"); await settle();
  const output = text(render(status)); expect(output).toContain(saved.observation.answer); expect(output).toContain("参考答案");
  expect(output).not.toContain("我的原答案"); expect(output).not.toContain("我答对了");
  expect(api.getSubmittedAttempt).toHaveBeenCalledWith(id, id, 3); expect(api.getAnswerKey).toHaveBeenCalledWith(id, id, id);
  expect(api.createSession).not.toHaveBeenCalled(); expect(api.submitAttempt).not.toHaveBeenCalled();
  unmount(); render(status); await settle(); expect(text(render(status))).toContain(saved.observation.answer);
});
it("preserves recovered answer when the separate reference read fails", async () => {
  api.getAnswerKey.mockRejectedValueOnce(new Error("reference offline")); render(); await settle();
  expect(text(render())).toContain(saved.observation.answer); expect(text(render())).toContain("重新读取参考答案");
});
it("does not present a new answer form after a failed recovery read", async () => {
  api.getSubmittedAttempt.mockRejectedValueOnce(new Error("offline")); render(); await settle();
  expect(text(render())).toContain("重新读取已保存的作答"); expect(text(render())).not.toContain("提交原答案");
});
it("does not restore retracted answers or unlock their reference", async () => {
  api.getSubmittedAttempt.mockResolvedValueOnce({ ...saved, observation: null }); render(); await settle();
  expect(text(render())).toContain("已撤回或不可用"); expect(api.getAnswerKey).not.toHaveBeenCalled();
});
it("shows an honest empty read-only review when no answer was submitted", async () => {
  api.getSubmittedAttempt.mockResolvedValueOnce(null); render("completed"); await settle();
  expect(text(render("completed"))).toContain("没有可恢复的已提交作答"); expect(api.getAnswerKey).not.toHaveBeenCalled();
});
it("ignores a recovery result arriving after unmount", async () => {
  let resolve!: (value: typeof saved) => void;
  api.getSubmittedAttempt.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  render(); unmount(); resolve(saved); await settle(); expect(api.getAnswerKey).not.toHaveBeenCalled();
});
