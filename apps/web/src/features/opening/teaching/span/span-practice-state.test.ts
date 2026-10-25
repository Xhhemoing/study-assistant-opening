import { isValidElement, type ReactElement, type ReactNode, type ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation, SpanHintLevel } from "@aistudy/contracts";
import type { DraftPatch, PracticeDraft } from "../../learning/practice-draft";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? next(hooks.values[i]) : next; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useMemo: (factory: () => unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.values[i] = { value: factory(), deps }; return (hooks.values[i] as { value: unknown }).value; },
  useCallback: (callback: unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.values[i] = { value: callback, deps }; return (hooks.values[i] as { value: unknown }).value; },
  useEffect: (effect: () => unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.effects.push(() => { previous?.cleanup?.(); hooks.values[i] = { deps, cleanup: effect() }; }); },
}));
const mocks = vi.hoisted(() => ({ draft: null as PracticeDraft | null, readRecord: vi.fn(), createSession: vi.fn(), createAttempt: vi.fn(), submitAttempt: vi.fn(), requireSaved: vi.fn(), ack: vi.fn(), haptic: vi.fn() }));
const studyBinding = vi.hoisted(() => ({ set: vi.fn() }));
const shortcuts = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("../../design/haptics", () => ({ successfulInteractionHaptic: mocks.haptic }));
vi.mock("../../assistant/current-study-context", () => ({ useStudyAssistantContext: studyBinding.set }));
vi.mock("../lesson-shortcuts", () => ({ useLessonArrowKeys: shortcuts.set }));
vi.mock("../../shell/workspace-layout-context", () => ({ useWorkspaceLayout: () => ({ focusMode: false, toggleFocusMode: vi.fn() }) }));
vi.mock("../../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("../../client/learning-client", () => ({ createOpeningLearningClient: () => mocks }));
vi.mock("../../assistant/study-exposure-ack", () => ({ acknowledgeStudyExposure: mocks.ack }));
vi.mock("../../learning/practice-draft", async original => ({ ...await original<typeof import("../../learning/practice-draft")>(),
  readPracticeRecord: mocks.readRecord, readPracticeDraft: () => mocks.draft, runPracticeRequest: (_key: string, work: () => Promise<unknown>) => work(),
  usePracticeDraft: () => ({ draft: mocks.draft, ready: true, requireSaved: mocks.requireSaved,
    patch: (change: DraftPatch | ((draft: PracticeDraft) => DraftPatch)) => { const draft = mocks.draft!; const update = typeof change === "function" ? change(draft) : change;
      Object.assign(draft, { ...update, fields: { ...draft.fields, ...update.fields } }); return draft; } }),
}));
import { emptyPracticeDraft, practiceScope } from "../../learning/practice-draft";
import { getSpanProblem } from "@aistudy/domain";
import { HintLadder } from "../hint-ladder";
import { SpanPractice, spanPracticeScope } from "./span-practice";
import { SpanLesson } from "./span-lesson";
const id = "11111111-1111-4111-8111-111111111111";
const attempt: LearningAttempt = { requirementKey: null, historyRevision: 0, id, workspaceId: id, sessionId: id, courseId: id, skillLabel: "span", problemId: id, itemVersionId: id,
  sourceIds: [id], sourceVersions: { [id]: 1 }, startedAt: "2026-10-21T00:00:00Z", submittedAt: null, observationId: null, spanExercise: getSpanProblem("span-independent-3d")! };
const record = { id, answer: JSON.stringify({ membership: "in_span" }), assistance: "hinted" } as LearningObservation;
const props: ComponentProps<typeof SpanPractice> = { courseId: id, sourceIds: [id], problemId: "span-independent-3d", intent: { purpose: "self_study", timeBudgetMinutes: 15, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" }, onRecorded: vi.fn(), onAttempt: vi.fn() };
function find(node: ReactNode, match: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map(value => find(value, match)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  return match(node) ? node : find(node.props.children as ReactNode, match);
}
function render(input: ComponentProps<typeof SpanPractice> = props) {
  hooks.cursor = 0;
  const outer = SpanPractice(input), form = outer.props.children[0] as ReactElement;
  const tree = (form.type as (props: unknown) => ReactNode)(form.props);
  hooks.effects.splice(0).forEach(effect => effect()); return tree;
}
function ladder(tree = render()) { return find(tree, node => node.type === HintLadder)!.props as ComponentProps<typeof HintLadder>; }
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function response(level: SpanHintLevel) {
  return Response.json({ attemptId: id, level, text: `server hint ${level}`, exposureReceipt: { id, releaseKey: level === 4 ? `span-feedback:${id}` : `span-hint-v1:${id}:${level}`,
    contextAnchor: { attemptId: id, itemVersionId: id, courseId: id, purpose: level === 4 ? "history_solution" : "learning_help" }, origin: level === 4 ? "history_solution" : "assistant", supportDomain: level === 4 ? "unknown" : "math",
    generatedAt: "2026-10-21T00:00:00Z", releasedAt: "2026-10-21T00:00:00Z", acknowledgedAt: null, historyRevision: level } });
}
async function start() { render(); await settle(); render(); }
beforeEach(() => {
  for (const value of hooks.values) (value as { cleanup?: () => void } | null)?.cleanup?.(); hooks.values = []; hooks.effects = []; vi.clearAllMocks();
  mocks.draft = emptyPracticeDraft(practiceScope(id, "span", null), { spanProblemId: props.problemId, sourceId: id, answer: JSON.stringify({ membership: "in_span" }), assistance: "independent" });
  mocks.createSession.mockResolvedValue({ id }); mocks.createAttempt.mockResolvedValue(attempt); mocks.submitAttempt.mockResolvedValue(record);
  mocks.readRecord.mockResolvedValue({ observation: null, deliveredAssistance: "none" }); mocks.ack.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ activityDecision: { id, reasonCodes: [], dataAsOf: "2026-10-21T00:00:00Z" } })));
});
it("retains the answer and current level on failed delivery, then records only the accepted hint", async () => {
  await start(); const original = mocks.draft!.fields.answer;
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
  ladder().next!.request(); await settle();
  expect(ladder().delivered).toEqual([]); expect(ladder().next!.label).toBe("方向提示"); expect(mocks.ack).not.toHaveBeenCalled();
  expect(mocks.draft!.fields.assistance).toBe("independent"); expect(mocks.draft!.fields.answer).toBe(original);
  vi.mocked(fetch).mockResolvedValueOnce(response(1));
  const next = ladder().next!; next.request(); next.request(); await settle();
  expect(ladder().delivered.map(value => value.text)).toEqual(["server hint 1"]); expect(ladder().next!.label).toBe("定义提醒");
  expect(mocks.draft!.fields.assistance).toBe("hinted"); expect(mocks.draft!.fields.answer).toBe(original); expect(mocks.ack).toHaveBeenCalledOnce(); expect(mocks.haptic).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("keeps full demonstration disabled until the durable original is read and preserves that original", async () => {
  await start();
  for (const level of [1, 2, 3] as const) { vi.mocked(fetch).mockResolvedValueOnce(response(level)); ladder().next!.request(); await settle(); }
  expect(ladder().next).toMatchObject({ label: "完整示范", disabled: true });
  const calls = vi.mocked(fetch).mock.calls.length; ladder().next!.request(); await settle(); expect(fetch).toHaveBeenCalledTimes(calls);
  mocks.readRecord.mockResolvedValue({ observation: record, deliveredAssistance: "hinted" });
  const form = find(render(), node => node.type === "form")!; (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} }); await settle();
  expect(ladder().next!.disabled).toBe(false); expect(props.onRecorded).toHaveBeenCalledWith(record);
  vi.mocked(fetch).mockResolvedValueOnce(response(4)); ladder().next!.request(); await settle();
  expect(ladder().next).toBeUndefined(); expect(mocks.draft!.fields.deliveredAssistance).toBe("revealed");
  expect(record.assistance).toBe("hinted"); expect(mocks.submitAttempt).toHaveBeenCalledOnce(); expect(props.onRecorded).toHaveBeenCalledOnce(); expect(mocks.haptic).toHaveBeenCalledOnce();
});
it("clears the registered attempt when its draft unmounts and ignores a delayed recovery callback", async () => {
  let resolve!: (value: { observation: null; deliveredAssistance: "none" }) => void;
  mocks.readRecord.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  await start();
  expect(props.onAttempt).toHaveBeenCalledWith(null);
  for (const value of hooks.values) (value as { cleanup?: () => void } | null)?.cleanup?.();
  resolve({ observation: null, deliveredAssistance: "none" }); await settle();
  expect(props.onAttempt).not.toHaveBeenCalledWith(attempt); expect(props.onRecorded).not.toHaveBeenCalled();
});
it("registers the sole active span entry and never carries a previous step's attempt into a new question", () => {
  const lessonProps = { courseId: id, sourceIds: [id], sourceLoadError: false, initialNewEvidenceEventId: id };
  const lesson = () => { hooks.cursor = 0; const tree = SpanLesson(lessonProps); hooks.effects.splice(0).forEach(effect => effect()); return tree; };
  const first = lesson(); const initial = find(first, node => node.type === SpanPractice)!;
  (initial.props.onAttempt as (value: LearningAttempt | null) => void)(attempt); lesson();
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ learningAttempt: attempt, context: expect.objectContaining({ attemptId: id, itemVersionId: id }) }));
  const navigation = find(lesson(), node => node.type === "nav" && node.props["aria-label"] === "span 教学步骤")!;
  const steps = navigation.props.children as ReactElement<{ onClick: () => void }>[];
  steps[0]!.props.onClick(); lesson();
  // 示范步骤可以直接围绕课程提问，但绝不携带上一题的作答。
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ isQuestion: false, learningAttempt: null, blockedReason: undefined }));
  expect(studyBinding.set.mock.lastCall![0].context).not.toHaveProperty("attemptId");
  steps[1]!.props.onClick(); lesson();
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ isQuestion: true, learningAttempt: null }));
  expect(studyBinding.set.mock.lastCall![0].context).not.toHaveProperty("attemptId");
  expect(shortcuts.set.mock.lastCall![1]).toMatchObject({ previous: expect.any(Function), next: undefined });
  (initial.props.onAttempt as (value: LearningAttempt | null) => void)(attempt); lesson();
  expect(studyBinding.set).toHaveBeenLastCalledWith(expect.objectContaining({ learningAttempt: null }));
  const current = find(lesson(), node => node.type === SpanPractice)!;
  (current.props.onRecorded as (record: LearningObservation) => void)({ ...record, serverEvaluation: { decision: "correct" } } as LearningObservation); lesson();
  expect(shortcuts.set.mock.lastCall![1].next).toBeTypeOf("function");
});

it("restores a server-owned sealed answer and only the exact previously released hint levels", async () => {
  const secondSource = "22222222-2222-4222-8222-222222222222";
  const restoredProps: ComponentProps<typeof SpanPractice> = { ...props, restoredAttempt: { ...attempt, observationId: id, sourceIds: [id, secondSource], contextAnchor: { courseId: id, attemptId: id, itemVersionId: id, activityId: id, sourceId: secondSource, purpose: "learning_help" } }, restoredHintLevels: [2],
    session: { activityId: id, sessionId: id, courseId: id, sourceIds: [id], intent: props.intent, moveId: "self-independent", status: "active", revision: 3, retestId: null, createdAt: attempt.startedAt, updatedAt: attempt.startedAt } };
  mocks.draft = emptyPracticeDraft(spanPracticeScope(id, undefined, undefined, id, props.problemId), { sourceId: id, spanProblemId: props.problemId });
  mocks.readRecord.mockResolvedValue({ observation: record, originalObservation: { ...record, answer: "sealed first answer" }, deliveredAssistance: "hinted" });
  vi.mocked(fetch).mockResolvedValueOnce(response(2));
  render(restoredProps); await settle(); render(restoredProps); await settle();
  const tree = render(restoredProps);
  const recovered = find(tree, node => node.type === HintLadder)!.props as ComponentProps<typeof HintLadder>;
  expect(mocks.createSession).not.toHaveBeenCalled(); expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled();
  expect(props.onRecorded).toHaveBeenCalledWith(record);
  expect(recovered.delivered.map(hint => hint.label)).toEqual(["2. 定义提醒"]);
  expect(recovered.next?.label).toBe("第一步");
  expect(vi.mocked(fetch).mock.calls.map(call => JSON.parse(String(call[1]?.body)))).toEqual([{ attemptId: id, level: 2 }]);
  expect(mocks.draft!.attemptId).toBe(attempt.id); expect(mocks.draft!.fields.deliveredAssistance).toBe("hinted");
  expect(mocks.draft!.fields.sourceId).toBe(secondSource);
  expect(find(tree, node => node.type === "pre" && node.props.children === "sealed first answer")).toBeDefined();
  expect(mocks.haptic).not.toHaveBeenCalled();
});

it("isolates a practice draft by lesson, step and exact new-evidence event", () => {
  const activity = "22222222-2222-4222-8222-222222222222";
  const other = "33333333-3333-4333-8333-333333333333";
  const scope = spanPracticeScope(id, undefined, undefined, activity, "span-independent-3d");
  expect(scope).not.toBe(spanPracticeScope(id, undefined, undefined, other, "span-independent-3d"));
  expect(scope).not.toBe(spanPracticeScope(id, undefined, undefined, activity, "span-faded-3d"));
  expect(scope).not.toBe(spanPracticeScope(id, undefined, other, activity, "span-independent-3d"));
  expect(spanPracticeScope(id)).toBe(practiceScope(id, "span", null));
});
it("shows pending restored answers as needing verification while retaining the exact attempt", async () => {
  mocks.createAttempt.mockResolvedValue({ ...attempt, spanValidation: { eligible: false, firstFamilyExposure: false, reasonCode: "restored_identity_unverified" } });
  await start();
  const tree = render();
  expect(mocks.draft!.attemptId).toBe(attempt.id);
  expect(find(tree, node => node.type === "button" && node.props.children === "提交答案（稍后核对）")).toBeDefined();
});
it("does not replace an unavailable historical question with a new practice entry", () => {
  hooks.cursor = 0;
  const tree = SpanLesson({ courseId: id, sourceIds: [id], sourceLoadError: false, initialMoveId: "self-independent",
    restoredAttempts: [{ ...attempt, spanExercise: undefined }] });
  expect(find(tree, node => node.props.role === "alert")).toBeDefined();
  expect(find(tree, node => node.type === SpanPractice)).toBeUndefined();
});
