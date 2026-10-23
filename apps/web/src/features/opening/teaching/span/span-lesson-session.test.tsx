import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SpanLessonSnapshot } from "@aistudy/contracts";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? initial() : initial; return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? next(hooks.values[i]) : next; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useCallback: (callback: unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { value: unknown; deps: unknown[] } | undefined; if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.values[i] = { value: callback, deps }; return (hooks.values[i] as { value: unknown }).value; },
  useEffect: (effect: () => unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { deps: unknown[]; cleanup?: () => void } | undefined; if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.effects.push(() => { previous?.cleanup?.(); hooks.values[i] = { deps, cleanup: effect() }; }); },
}));
const mocks = vi.hoisted(() => ({ request: vi.fn(), replaceState: vi.fn() }));
vi.mock("./span-session-client", async original => ({ ...await original<typeof import("./span-session-client")>(), spanLessonRequest: mocks.request }));
import { SpanLessonSession } from "./span-lesson-session";
import { SpanLesson } from "./span-lesson";
const id = "11111111-1111-4111-8111-111111111111", sourceId = "22222222-2222-4222-8222-222222222222";
const snapshot: SpanLessonSnapshot = { activityId: id, sessionId: id, courseId: id, sourceIds: [sourceId], intent: { purpose: "self_study", timeBudgetMinutes: 20, pace: "normal", language: "zh", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self-example", status: "active", revision: 1, retestId: null, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" };
const details = (session: SpanLessonSnapshot | null) => ({ session, attempts: [], observations: [], assistance: {}, hintLevels: {}, intentEvent: null });
const props = { courseId: id, sourceIds: [id], sourceLoadError: false };
function find(node: ReactNode, match: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map(value => find(value, match)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  return match(node) ? node : find(node.props.children as ReactNode, match);
}
function render() { hooks.cursor = 0; const tree = SpanLessonSession(props); hooks.effects.splice(0).forEach(effect => effect()); return tree; }
function lesson() { return find(render(), element => element.type === SpanLesson)! as ReactElement<ComponentProps<typeof SpanLesson>>; }
function unmount() { for (const value of hooks.values) (value as { cleanup?: () => void } | null)?.cleanup?.(); }
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
beforeEach(() => { unmount(); hooks.values = []; hooks.effects = []; vi.clearAllMocks(); mocks.request.mockReset(); mocks.request.mockResolvedValue(details(snapshot)); vi.stubGlobal("window", { location: { href: `http://example.test/opening/courses/${id}/study/span` }, history: { state: null, replaceState: mocks.replaceState } }); });
it("applies an explicit recovery snapshot to the lesson while ordinary progress saves retain its editing tree", async () => {
  render(); await settle(); const first = lesson();
  expect(first.props.sourceIds).toEqual([sourceId]);
  mocks.request.mockResolvedValueOnce({ ...snapshot, revision: 2, moveId: "self-faded" });
  await first.props.onProgress!(snapshot.intent, "self-faded", "active");
  expect(lesson().key).toBe(first.key);
  mocks.request.mockRejectedValueOnce(new Error("另一页面已更新学习进度"));
  await lesson().props.onProgress!(snapshot.intent, "self-independent", "active");
  mocks.request.mockResolvedValueOnce(details({ ...snapshot, revision: 9, moveId: "self-independent", intent: { ...snapshot.intent, timeBudgetMinutes: 7 } }));
  const retry = find(render(), element => element.type === "button" && element.props.children === "继续加载")!;
  (retry.props.onClick as () => void)(); render(); await settle(); const restored = lesson();
  expect(restored.key).not.toBe(first.key);
  expect(restored.props.initialMoveId).toBe("self-independent"); expect(restored.props.initialIntent?.timeBudgetMinutes).toBe(7);
  expect(restored.props.session?.revision).toBe(9);
});
it.each(["start", "save"] as const)("does not let an interrupted %s request rewrite the next page's URL", async action => {
  mocks.request.mockResolvedValueOnce(details(action === "start" ? null : snapshot));
  render(); await settle();
  let resolve!: (value: SpanLessonSnapshot) => void;
  mocks.request.mockImplementationOnce(() => new Promise<SpanLessonSnapshot>(done => { resolve = done; }));
  if (action === "start") {
    render(); // A successful recovery read starts a new session without a click.
  } else void lesson().props.onProgress!(snapshot.intent, "self-faded", "active");
  unmount(); resolve({ ...snapshot, revision: 2 }); await settle();
  expect(mocks.replaceState).not.toHaveBeenCalled();
});
