import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningAttempt, LearningAttemptContextRead } from "@aistudy/contracts";
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => unknown>, read: vi.fn() }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(),
  useMemo: <T,>(factory: () => T) => factory(),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: T | ((current: T) => T)) => { hooks.slots[index] = typeof value === "function" ? (value as (current: T) => T)(hooks.slots[index] as T) : value; }];
  },
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));
vi.mock("../client/learning-client", () => {
  const client = { getAttemptContext: hooks.read };
  return { createOpeningLearningClient: () => client };
});
vi.mock("./assistant-view", () => ({ AssistantView: () => null }));
import { AssistantSession } from "./assistant-session";
import { AssistantView } from "./assistant-view";
import { ConversationSurface } from "./conversation-companion";
import type { AssistantEntry } from "./assistant-entry";
import { LoadError, LoadingRows } from "../design/ui";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const attempt: LearningAttempt = { id, workspaceId: id, sessionId: id, courseId: id, skillLabel: "span", requirementKey: "span:v1", problemId: id, itemVersionId: id,
  sourceIds: [id], sourceVersions: { [id]: 2 }, startedAt: "2026-10-21T00:00:00Z", submittedAt: null, observationId: null, historyRevision: 1,
  contextAnchor: { courseId: id, activityId: id, blockId: id, contentVersion: 2, attemptId: id, itemVersionId: id, sourceId: id, sourceVersion: 2, page: 1, chunkId: id, kcMappingVersion: 1, purpose: "learning_help" } };
const entry: AssistantEntry = { key: "legacy", label: "本题提问", context: { attemptId: id }, fresh: true, conversation: null };
const response = (value = attempt): LearningAttemptContextRead => ({ attempt: value, deliveredAssistance: "hinted" });
type Tree = ReactElement<{ children: ReactElement<{ message?: string; onRetry?: () => void }>; learningAttempt?: LearningAttempt; studyContext?: AssistantEntry["context"] }>;
function render(value: AssistantEntry & { learningAttempt?: LearningAttempt } = entry): Tree {
  hooks.cursor = 0; hooks.effects.length = 0;
  return AssistantSession({ entry: value }) as Tree;
}
function runEffects() { return hooks.effects.map(effect => effect()).filter((value): value is () => void => typeof value === "function"); }
async function flush() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }
beforeEach(() => { hooks.slots.length = 0; hooks.cursor = 0; hooks.effects.length = 0; hooks.read.mockReset().mockResolvedValue(response()); });

describe("assistant canonical attempt restoration", () => {
  it("loads a real attempt, fills canonical pins, and restores it again after the drawer unmounts", async () => {
    expect(render().props.children.type).toBe(LoadingRows);
    const cleanups = runEffects();
    await flush();
    const restored = render();
    expect(restored.type).toBe(AssistantView);
    expect(restored.props.learningAttempt).toEqual(attempt);
    expect(restored.props.studyContext).toMatchObject(attempt.contextAnchor!);
    expect(restored.props.learningAttempt).not.toHaveProperty("answer");
    cleanups.forEach(cleanup => cleanup());
    hooks.slots.length = 0;
    expect(render().props.children.type).toBe(LoadingRows);
    runEffects(); await flush();
    expect(render().props.learningAttempt).toEqual(attempt);
    expect(hooks.read).toHaveBeenCalledTimes(2);
  });

  it.each([
    { courseId: other }, { activityId: other }, { blockId: other }, { itemVersionId: other }, { contentVersion: 3 },
    { sourceId: other }, { sourceVersion: 3 }, { page: 2 }, { chunkId: other }, { kcMappingVersion: 2 },
  ])("blocks a caller-selected identity or version that differs from the canonical attempt: %j", async mismatch => {
    const selected = { ...entry, context: { ...entry.context, ...mismatch } };
    render(selected); runEffects(); await flush();
    const result = render(selected);
    expect(result.type).not.toBe(AssistantView);
    expect(result.props.children.type).toBe(LoadError);
    expect(result.props.children.props.message).toContain("与原题的作答记录不一致");
  });

  it("keeps the explicit support purpose while restoring the same canonical question", async () => {
    const selected = { ...entry, context: { ...entry.context, purpose: "language_support" as const } };
    render(selected); runEffects(); await flush();
    expect(render(selected).props.studyContext).toMatchObject({ attemptId: id, itemVersionId: id, sourceVersion: 2, purpose: "language_support" });
  });

  it("does not inherit an earlier answer-reading purpose when this entry requests ordinary help", async () => {
    hooks.read.mockResolvedValueOnce(response({ ...attempt, contextAnchor: { ...attempt.contextAnchor!, purpose: "history_solution" } }));
    render(); runEffects(); await flush();
    expect(render().props.studyContext?.purpose).toBe("learning_help");
  });

  it("invalidates the old binding immediately and ignores its late response when the selected attempt changes", async () => {
    let finishOld!: (value: LearningAttemptContextRead) => void;
    let finishNew!: (value: LearningAttemptContextRead) => void;
    hooks.read.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    render(); const oldCleanup = runEffects();
    const next = { ...entry, context: { attemptId: other } };
    expect(render(next).props.children.type).toBe(LoadingRows);
    oldCleanup.forEach(cleanup => cleanup());
    runEffects();
    finishOld(response()); await flush();
    expect(render(next).props.children.type).toBe(LoadingRows);
    const nextAttempt = { ...attempt, id: other, contextAnchor: { ...attempt.contextAnchor!, attemptId: other } };
    finishNew(response(nextAttempt)); await flush();
    expect(render(next).props.learningAttempt?.id).toBe(other);
    // Changing back cannot reuse the other question's last successful value.
    expect(render().props.children.type).toBe(LoadingRows);
  });

  it("drops a previously successful binding when another selection starts loading", async () => {
    render(); const cleanups = runEffects(); await flush();
    expect(render().props.learningAttempt).toEqual(attempt);
    cleanups.forEach(cleanup => cleanup());
    hooks.read.mockImplementationOnce(() => new Promise(() => {}));
    render({ ...entry, context: { attemptId: other } }); runEffects();
    expect(render().props.children.type).toBe(LoadingRows);
  });

  it("never mounts an unbound assistant after missing, denied, or mismatched restoration", async () => {
    hooks.read.mockRejectedValueOnce(new Error("材料版本不可用"));
    render(); runEffects(); await flush();
    expect(render().props.children.props.message).toBe("材料版本不可用");
    hooks.read.mockResolvedValueOnce(response({ ...attempt, id: other }));
    render().props.children.props.onRetry?.();
    render(); runEffects(); await flush();
    expect(render().props.children.props.message).toContain("与原题的作答记录不一致");
  });

  it("passes a supplied canonical attempt directly and still validates its selected pins", () => {
    const selected = { ...entry, learningAttempt: attempt };
    expect(render(selected).props.learningAttempt).toBe(attempt);
    runEffects();
    expect(hooks.read).not.toHaveBeenCalled();
    const wrong = { ...selected, context: { attemptId: id, courseId: other } };
    expect(render(wrong).props.children.type).toBe(LoadError);
  });

  it("restores an independent saved chat through the ordinary host without changing its identity", () => {
    hooks.cursor = 0;
    const result = AssistantSession({ entry: { ...entry, context: undefined, conversation: id, fresh: false }, embedded: false }) as ReactElement<{ initialConversationId: string; startFresh: boolean }>;
    expect(result.type).toBe(ConversationSurface);
    expect(result.props.initialConversationId).toBe(id);
    expect(result.props.startFresh).toBe(false);
    runEffects();
    expect(hooks.read).not.toHaveBeenCalled();
  });

  it("keeps independent task help outside the ordinary host, including its selection and support purpose", async () => {
    const selected = { ...entry, context: { attemptId: id, purpose: "language_support" as const, fragment: "确切选区" } };
    hooks.cursor = 0;
    AssistantSession({ entry: selected, embedded: false }); runEffects(); await flush();
    hooks.cursor = 0;
    const result = AssistantSession({ entry: selected, embedded: false }) as Tree;
    expect(result.type).toBe(AssistantView);
    expect(result.props.learningAttempt).toEqual(attempt);
    expect(result.props.studyContext).toMatchObject({ ...attempt.contextAnchor, fragment: "确切选区", purpose: "language_support" });
  });

  it("preserves ordinary free conversation without inventing a learning attempt", () => {
    const free = { ...entry, context: undefined, fresh: false };
    expect(render(free).type).toBe(AssistantView);
    expect(render(free).props.learningAttempt).toBeUndefined();
    runEffects();
    expect(hooks.read).not.toHaveBeenCalled();
  });
});
