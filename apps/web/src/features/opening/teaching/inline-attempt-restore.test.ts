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
const api = vi.hoisted(() => ({ getSubmittedAttempt: vi.fn(), getAnswerKey: vi.fn(), createSession: vi.fn(), createAttempt: vi.fn(), submitAttempt: vi.fn() }));
const studyBinding = vi.hoisted(() => ({ set: vi.fn() }));
const hintApi = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), ack: vi.fn() }));
vi.mock("./teaching-hint-client", async original => ({ ...await original<typeof import("./teaching-hint-client")>(), requestTeachingHint: hintApi.request, readReleasedTeachingHints: hintApi.read }));
vi.mock("../assistant/study-exposure-ack", () => ({ acknowledgeStudyExposure: hintApi.ack }));
const haptic = vi.hoisted(() => vi.fn());
vi.mock("../design/haptics", () => ({ successfulInteractionHaptic: haptic }));
const shortcuts = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("../assistant/current-study-context", () => ({ useStudyAssistantContext: studyBinding.set }));
vi.mock("../shell/workspace-layout-context", () => ({ useWorkspaceLayout: () => ({ focusMode: false, toggleFocusMode() {}, setFocusMode() {} }) }));
vi.mock("./lesson-shortcuts", () => ({ useLessonArrowKeys: shortcuts.set }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("./activity-client", () => ({ createTeachingActivityClient: () => api }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => ({ ...api, getSummary: async () => [] }) }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => ({ getCourseKnowledge: async () => ({ snapshot: null }) }) }));
import { InlineAttemptForm, type InlineAttemptContext } from "./inline-attempt";
import { TeachingWorkspace, type TeachingWorkspaceProps } from "./teaching-workspace";
import { HintLadder } from "./hint-ladder";
import { InlineAnswerInput } from "./inline-answer-input";
import { studentCopy } from "./student-copy";
import { OpeningApiError } from "../client/api";
import { TeachingBlockItem } from "./teaching-block-item";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
const id = "11111111-1111-4111-8111-111111111111";
const canonicalAttempt: LearningAttempt = { id, workspaceId: id, courseId: id, sessionId: id, skillLabel: "技能", requirementKey: `teaching:${id}:v3`, sourceIds: [], sourceVersions: {}, itemVersionId: null, problemId: null, startedAt: "2026-10-21T00:00:00Z", submittedAt: null, observationId: null };
const saved = { attempt: canonicalAttempt, observation: { id, attemptId: id, courseId: id, sessionId: id, answer: "原先保存的答案", referenceCheck: { method: "comparison" }, outcome: "correct" } };
const context: InlineAttemptContext = { id, courseId: id, sourceIds: [], contentVersion: 3, status: "active", intentSummary: "练习", onCourseAssociated: vi.fn(), onObservationReady: vi.fn(), onAttemptReady: vi.fn() };
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render(status: InlineAttemptContext["status"] = "active", initialDraft?: import("./inline-attempt-drafts").InlineAttemptDraft) {
  hooks.cursor = 0;
  const tree = InlineAttemptForm({ blockId: id, prompt: "题目", context: { ...context, status }, ready: true, initialDraft, onDraftChange: vi.fn() });
  hooks.effects.splice(0).forEach(effect => effect()); return tree;
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function unmount() { for (const value of hooks.values) (value as { cleanup?: () => void } | null)?.cleanup?.(); hooks.values = []; hooks.effects = []; }
beforeEach(() => { unmount(); vi.clearAllMocks(); api.getSubmittedAttempt.mockResolvedValue(saved); api.getAnswerKey.mockResolvedValue({ answer: "参考", referenceSourceId: id }); api.createSession.mockResolvedValue({ id }); api.createAttempt.mockResolvedValue(canonicalAttempt); api.submitAttempt.mockResolvedValue(saved.observation); hintApi.ack.mockResolvedValue(undefined); hintApi.read.mockResolvedValue([]); });
it.each(["active", "completed"] as const)("restores durable answer on fresh %s mount without replaying submission", async status => {
  expect(text(render(status))).toContain("正在恢复"); await settle();
  const output = text(render(status)); expect(output).toContain(saved.observation.answer); expect(output).toContain(studentCopy.referenceAvailable);
  expect(output).not.toContain("我的原答案"); expect(output).not.toContain("我答对了");
  expect(api.getSubmittedAttempt).toHaveBeenCalledWith(id, id, 3); expect(api.getAnswerKey).not.toHaveBeenCalled();
  expect(api.createSession).not.toHaveBeenCalled(); expect(api.submitAttempt).not.toHaveBeenCalled(); expect(haptic).not.toHaveBeenCalled();
  expect(context.onObservationReady).toHaveBeenCalledWith(id, saved.observation);
  unmount(); render(status); await settle(); expect(text(render(status))).toContain(saved.observation.answer);
});
it("preserves recovered answer when the explicit reference read fails", async () => {
  hintApi.request.mockRejectedValueOnce(new Error("reference offline")); render(); await settle();
  const tree = render(); const ladder = findNode(tree, node => node.type === HintLadder)!;
  (ladder.next as { request: () => void }).request(); await settle();
  expect(text(render())).toContain(saved.observation.answer); expect(text(render())).toContain("reference offline");
  expect(api.getAnswerKey).not.toHaveBeenCalled();
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
it("prepares before hints without sealing an answer, then submits the edited original under the prepared attempt", async () => {
  api.getSubmittedAttempt.mockResolvedValue(null);
  const draft = { answer: "最初草稿", skillLabel: "技能", prompt: "题目" };
  render("active", draft); await settle();
  render("active", draft); await settle();
  expect(api.submitAttempt).not.toHaveBeenCalled(); expect(api.getAnswerKey).not.toHaveBeenCalled();
  expect(context.onAttemptReady).toHaveBeenCalledWith(id, canonicalAttempt);
  const hint = { attemptId: id, level: 1, text: "真实方向提示", referenceSourceId: null, exposureReceipt: { id } };
  hintApi.request.mockResolvedValueOnce(hint);
  const ladder = findNode(render("active", draft), node => node.type === HintLadder)!;
  (ladder.next as { request: () => void }).request(); await settle();
  expect(hintApi.ack).toHaveBeenCalledWith(hint.exposureReceipt);
  expect(api.submitAttempt).not.toHaveBeenCalled();
  const input = findNode(render("active", draft), node => node.type === InlineAnswerInput)!;
  (input.onChange as (value: string) => void)("我继续修改后的首答");
  const form = findNode(render("active", draft), node => node.type === "form")!;
  (form.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} }); await settle();
  expect(api.createSession).toHaveBeenCalledOnce(); expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
  expect(api.submitAttempt).toHaveBeenCalledWith(id, expect.objectContaining({ answer: "我继续修改后的首答" }));
  expect(api.getAnswerKey).not.toHaveBeenCalled(); expect(hintApi.request).toHaveBeenCalledOnce();
  expect(haptic).toHaveBeenCalledOnce(); expect(text(render("active", draft))).toContain(studentCopy.referenceAvailable);
});
it("restores prepared identity with a canonical replay while leaving the answer editable and the reference unopened", async () => {
  api.getSubmittedAttempt.mockResolvedValue(null);
  const draft = { answer: "仍在编辑的草稿", skillLabel: "技能", prompt: "题目", preparation: { input: { activityId: id, courseId: id, blockId: id, contentVersion: 3, sourceIds: [], prompt: "题目", skillLabel: "技能" }, attemptKey: `teaching-attempt:${id}`, sessionId: id, attemptId: id } };
  render("active", draft); await settle();
  const input = findNode(render("active", draft), node => node.type === InlineAnswerInput)!;
  expect(input.value).toBe(draft.answer); expect(input.disabled).toBe(false);
  expect(api.createSession).not.toHaveBeenCalled(); expect(api.createAttempt).toHaveBeenCalledOnce();
  expect(context.onAttemptReady).toHaveBeenCalledWith(id, canonicalAttempt);
  expect(api.submitAttempt).not.toHaveBeenCalled(); expect(hintApi.request).not.toHaveBeenCalled(); expect(api.getAnswerKey).not.toHaveBeenCalled();
});
it("reads the preserved reference only after an explicit action on a restored answer", async () => {
  render(); await settle();
  expect(hintApi.request).not.toHaveBeenCalled();
  hintApi.request.mockResolvedValueOnce({ attemptId: id, level: 4, text: "持久的参考解答", referenceSourceId: id, exposureReceipt: { id } });
  const ladder = findNode(render(), node => node.type === HintLadder)!;
  expect((ladder.next as { label: string }).label).toBe("参考解答");
  (ladder.next as { request: () => void }).request(); await settle();
  expect(hintApi.request).toHaveBeenCalledWith(canonicalAttempt, { activityId: id, blockId: id, contentVersion: 3 }, 4);
  expect(hintApi.ack).toHaveBeenCalledOnce(); expect(text(render())).toContain(saved.observation.answer);
  expect(api.submitAttempt).not.toHaveBeenCalled(); expect(haptic).not.toHaveBeenCalled();
});
it("keeps an old content version's missing hints from blocking original-answer submission", async () => {
  api.getSubmittedAttempt.mockResolvedValue(null);
  const draft = { answer: "尚未提交的原答案", skillLabel: "技能", prompt: "题目" };
  render("active", draft); await settle();
  render("active", draft); await settle();
  hintApi.request.mockRejectedValueOnce(new OpeningApiError(409, "此版教学内容没有分级提示，仍可提交作答"));
  (findNode(render("active", draft), node => node.type === HintLadder)!.next as { request: () => void }).request(); await settle();
  const tree = render("active", draft);
  expect((findNode(tree, node => node.type === HintLadder)!.next as { disabled: boolean }).disabled).toBe(true);
  expect(findNode(tree, node => node.type === InlineAnswerInput)!.value).toBe(draft.answer);
  expect(hintApi.ack).not.toHaveBeenCalled();
  (findNode(tree, node => node.type === "form")!.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} }); await settle();
  expect(api.submitAttempt).toHaveBeenCalledOnce();
  expect(findNode(render("active", draft), node => node.type === HintLadder)!.next).toMatchObject({ label: "参考解答", disabled: false });
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
  const completed = { ...saved.observation, revisionKind: "replace", verdictSource: "self_report", outcome: "correct" } as LearningObservation;
  const blocked = (tree: ReactNode) => text(tree).includes("先提交你的想法，再继续下一单元");
  const props = workspaceProps(); const first = renderWorkspace(props), callback = observed(first);
  expect(blocked(first)).toBe(true);
  callback(followingId, completed);
  expect(blocked(renderWorkspace(props))).toBe(true);
  callback(questionId, { ...saved.observation, outcome: "unverified" } as LearningObservation);
  expect(text(renderWorkspace(props))).toContain("先核对本题结果，再继续下一单元");
  callback(questionId, completed);
  expect(blocked(renderWorkspace(props))).toBe(false);
  const revised = workspaceProps(questionId, 2); renderWorkspace(revised);
  expect(blocked(renderWorkspace(revised))).toBe(true);
  callback(questionId, completed);
  expect(blocked(renderWorkspace(revised))).toBe(true);
  observed(renderWorkspace(revised))(questionId, completed);
  expect(blocked(renderWorkspace(revised))).toBe(false);
});
it("registers only the current question and replaces its bound attempt when the version changes", () => {
  const props = workspaceProps(), tree = renderWorkspace(props);
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ isQuestion: true, learningAttempt: null, context: expect.objectContaining({ blockId: questionId, contentVersion: 1 }) }));
  const block = findNode(tree, node => node.type === TeachingBlockItem && (node.props.block as { blockId: string }).blockId === questionId)!;
  const attempt = { ...canonicalAttempt, itemVersionId: id, requirementKey: `teaching:${questionId}:v1` };
  (block.attemptContext as InlineAttemptContext).onAttemptReady!(questionId, attempt); renderWorkspace(props);
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ learningAttempt: attempt, blockedReason: undefined, context: expect.objectContaining({ attemptId: id, itemVersionId: id }) }));
  const revised = workspaceProps(questionId, 2); renderWorkspace(revised); renderWorkspace(revised);
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ learningAttempt: null, blockedReason: expect.any(String), context: expect.objectContaining({ contentVersion: 2, attemptId: undefined }) }));
});
