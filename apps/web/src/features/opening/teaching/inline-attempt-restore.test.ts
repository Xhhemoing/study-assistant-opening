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
  useCallback: (callback: unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.values[i] = { value: callback, deps };
    return (hooks.values[i] as { value: unknown }).value; },
  useEffect: (effect: () => unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.effects.push(() => {
      previous?.cleanup?.(); hooks.values[i] = { deps, cleanup: effect() }; }); },
}));
const api = vi.hoisted(() => ({ getSubmittedAttempt: vi.fn(), getAnswerKey: vi.fn(), createSession: vi.fn(), submitAttempt: vi.fn() }));
const studyBinding = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("../assistant/current-study-context", () => ({ useStudyAssistantContext: studyBinding.set }));
vi.mock("./activity-client", () => ({ createTeachingActivityClient: () => api }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => ({ ...api, getSummary: async () => [] }) }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => ({ getCourseKnowledge: async () => ({ snapshot: null }) }) }));
import { InlineAttemptForm, type InlineAttemptContext } from "./inline-attempt";
import { TeachingWorkspace, type TeachingWorkspaceProps } from "./teaching-workspace";
import { TeachingBlockItem } from "./teaching-block-item";
import type { LearningObservation } from "@aistudy/contracts";
const id = "11111111-1111-4111-8111-111111111111";
const saved = { attempt: { id }, observation: { id, answer: "原先保存的答案", referenceCheck: { method: "comparison" }, outcome: "correct" } };
const context: InlineAttemptContext = { id, courseId: id, sourceIds: [], contentVersion: 3, status: "active", intentSummary: "练习", onCourseAssociated: vi.fn(), onObservationReady: vi.fn() };
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
  expect(context.onObservationReady).toHaveBeenCalledWith(id, saved.observation);
  unmount(); render(status); await settle(); expect(text(render(status))).toContain(saved.observation.answer);
});
it("preserves recovered answer when the separate reference read fails", async () => {
  api.getAnswerKey.mockRejectedValueOnce(new Error("reference offline")); render(); await settle();
  expect(text(render())).toContain(saved.observation.answer); expect(text(render())).toContain("重新读取参考答案");
});
it("does not present a new answer form after a failed recovery read", async () => {
  api.getSubmittedAttempt.mockRejectedValueOnce(new Error("offline")); render(); await settle();
  expect(text(render())).toContain("重新读取已保存的作答"); expect(text(render())).not.toContain("提交原答案");
  expect(context.onObservationReady).not.toHaveBeenCalled();
});
it("clears the failed recovery error when retry succeeds", async () => {
  api.getSubmittedAttempt.mockRejectedValueOnce(new Error("offline")); render(); await settle();
  const failed = render();
  expect(text(failed)).toContain("offline");
  function findRetry(node: ReactNode): (() => void) | undefined {
    if (Array.isArray(node)) return node.map(findRetry).find(Boolean);
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return undefined;
    if (node.type === "button" && text(node) === "重新读取已保存的作答") return node.props.onClick;
    return findRetry(node.props.children);
  }
  const retry = findRetry(failed);
  expect(retry).toBeDefined(); retry!(); render(); await settle();
  const restored = text(render());
  expect(restored).toContain(saved.observation.answer);
  expect(restored).not.toContain("offline");
  expect(api.getSubmittedAttempt).toHaveBeenCalledTimes(2);
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

const questionId = "22222222-2222-4222-8222-222222222222", followingId = "33333333-3333-4333-8333-333333333333";
function workspaceProps(currentBlockId: string = questionId, contentVersion = 1): TeachingWorkspaceProps {
  const time = "2026-10-21T00:00:00Z";
  return { activity: { id, workspaceId: id, ownerUserId: id, courseId: id, status: "active", generateStatus: "ready", intentKind: "topic", intentSummary: "span", sourceIds: [], pathVersion: 1, contentVersion, clientKey: "workspace-gate", createdAt: time, updatedAt: time },
    clientInit: { id, activityId: id, teachingUnitId: id, documentId: id, revisionNumber: 1, blockOrder: [], sourceRefs: [], goals: [], verificationStatus: "structure_ok", generationConfig: {}, version: 1, createdAt: time, updatedAt: time, contentVersion, checkpointJson: { currentBlockId },
      blocks: [{ blockId: id, position: 0, blockType: "text", role: "teach", content: { text: "讲解" } }, { blockId: questionId, position: 1, blockType: "question", role: "prompt", content: { text: "试题" } }, { blockId: followingId, position: 2, blockType: "text", role: "teach", content: { text: "后续讲解" } }] },
    sourceNameById: { [id]: "已知来源" } };
}
function findNode(node: ReactNode, predicate: (node: { type: unknown; props: Record<string, unknown> }) => boolean): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map(value => findNode(value, predicate)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  return predicate(node) ? node.props : findNode(node.props.children as ReactNode, predicate);
}
function renderWorkspace(props: TeachingWorkspaceProps) {
  hooks.cursor = 0; const tree = TeachingWorkspace(props); hooks.effects.splice(0).forEach(effect => effect()); return tree;
}
function advance(tree: ReactNode) { return findNode(tree, node => node.props["data-teaching-primary-advance"] !== undefined)!; }
function observed(tree: ReactNode) { const block = findNode(tree, node => node.type === TeachingBlockItem && (node.props.block as { blockId: string }).blockId === questionId)!;
  return (block.attemptContext as InlineAttemptContext).onObservationReady!; }
it("allows a pure teaching unit to advance before any answer exists", () => {
  expect(advance(renderWorkspace(workspaceProps(id))).disabled).toBe(false);
});
it("unlocks only the current question's durable observation and rejects an old version callback", () => {
  const props = workspaceProps(); const first = renderWorkspace(props), callback = observed(first);
  expect(advance(first).disabled).toBe(true);
  callback(followingId, saved.observation as LearningObservation);
  expect(advance(renderWorkspace(props)).disabled).toBe(true);
  callback(questionId, saved.observation as LearningObservation);
  expect(advance(renderWorkspace(props)).disabled).toBe(false);
  const revised = workspaceProps(questionId, 2); renderWorkspace(revised);
  expect(advance(renderWorkspace(revised)).disabled).toBe(true);
  callback(questionId, saved.observation as LearningObservation);
  expect(advance(renderWorkspace(revised)).disabled).toBe(true);
  observed(renderWorkspace(revised))(questionId, saved.observation as LearningObservation);
  expect(advance(renderWorkspace(revised)).disabled).toBe(false);
});
it("registers only the current question and replaces its bound attempt when the version changes", () => {
  const props = workspaceProps(), tree = renderWorkspace(props);
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ isQuestion: true, learningAttempt: null, context: expect.objectContaining({ blockId: questionId, contentVersion: 1 }) }));
  const block = findNode(tree, node => node.type === TeachingBlockItem && (node.props.block as { blockId: string }).blockId === questionId)!;
  const attempt = { id, itemVersionId: id } as import("@aistudy/contracts").LearningAttempt;
  (block.attemptContext as InlineAttemptContext).onAttemptReady!(questionId, attempt); renderWorkspace(props);
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ learningAttempt: attempt, blockedReason: undefined, context: expect.objectContaining({ attemptId: id, itemVersionId: id }) }));
  const revised = workspaceProps(questionId, 2); renderWorkspace(revised); renderWorkspace(revised);
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ learningAttempt: null, blockedReason: expect.any(String), context: expect.objectContaining({ contentVersion: 2, attemptId: undefined }) }));
});
