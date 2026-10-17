import type { MeasurementAttempt, MeasurementOverview } from "@aistudy/contracts";
import { buildMeasurementReport } from "@aistudy/domain";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node-only interaction harness, following the planning component tests.
type Effect = { deps: unknown[]; effect: () => void | (() => void); cleanup?: () => void };
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void>, updates: 0 }));
const client = vi.hoisted(() => ({ courses: vi.fn(), read: vi.fn(), start: vi.fn(), status: vi.fn(), next: vi.fn(), act: vi.fn() }));
vi.mock("./client", () => ({ createMeasurementClient: () => client }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.updates += 1;
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.values[index] as { deps: unknown[]; value: unknown } | undefined;
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) hooks.values[index] = { deps, value: callback };
    return (hooks.values[index] as { value: unknown }).value;
  },
  useEffect: (effect: Effect["effect"], deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.values[index] as Effect | undefined;
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hooks.effects.push(() => {
        previous?.cleanup?.();
        hooks.values[index] = { deps, effect, cleanup: effect() };
      });
    }
  },
}));

import { LoadError } from "../design/ui";
import { MeasurementAttemptCard } from "./attempt-card";
import { MeasurementReportPanel } from "./report-panel";
import { MeasurementView } from "./measurement-view";
import type { MeasurementCourse } from "./client";

type Element = ReactElement<Record<string, unknown>>;
const courses: MeasurementCourse[] = [
  { id: "course-a", title: "积分课程", archivedAt: null },
  { id: "course-b", title: "第二课程", archivedAt: null },
];
const attempt: MeasurementAttempt = {
  id: "attempt", trialId: "trial-course-a", ordinal: 1,
  item: { id: "item", version: "1", skillId: "skill", skillLabel: "选法", familyId: "family", phase: "practice",
    prompt: "如何选取 u？", options: [{ id: "A", label: "x" }] },
  presentedAt: "2026-10-16T00:00:00Z", answeredAt: null, dueAt: null, firstAttempt: true,
  helpEvents: [], answer: null, outcome: null, retractedAt: null, retractionReason: null,
  predictions: [], feedback: null, feedbackWithheld: false,
};
function overview(courseId: string | null = "course-a", attempts: MeasurementAttempt[] = []): MeasurementOverview {
  return {
    trial: courseId ? { id: `trial-${courseId}`, courseId, unitId: "unit", protocolVersion: "v1", bankVersion: "v1", models: [],
      selectionPolicy: "fixed-common-probes-v1", status: "active", startedAt: attempt.presentedAt, practiceCompletedAt: null } : null,
    attempts, nextDueAt: null, report: buildMeasurementReport(attempts),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function componentProps<P>(tree: ReactNode, type: (props: P) => ReactNode): P {
  const found = elements(tree).find(element => element.type === type);
  expect(found).toBeDefined();
  return found!.props as P;
}
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(element => element.type === "button" && text(element) === label);
  expect(found).toBeDefined();
  return found!;
}
function click(element: Element) { (element.props.onClick as () => void)(); }
function select(tree: ReactNode) { return elements(tree).find(element => element.type === "select")!; }
function consent(tree: ReactNode, checked = true) {
  const input = elements(tree).find(element => element.type === "input" && element.props.type === "checkbox")!;
  (input.props.onChange as (event: unknown) => void)({ target: { checked } });
}
function changeCourse(tree: ReactNode, value: string) {
  (select(tree).props.onChange as (event: unknown) => void)({ target: { value } });
}
function effects() {
  return hooks.values.filter((value): value is Effect => !!value && typeof value === "object" && "effect" in value);
}
function unmount() { effects().forEach(effect => effect.cleanup?.()); }
function replayEffects() {
  unmount();
  effects().forEach(effect => { effect.cleanup = effect.effect() || undefined; });
}
function render() {
  hooks.cursor = 0;
  const tree = MeasurementView();
  hooks.effects.splice(0).forEach(effect => effect());
  return tree;
}
async function settle() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
async function ready(value = overview()) {
  client.read.mockResolvedValue(value);
  render(); await settle();
  return render();
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.updates = 0;
  vi.resetAllMocks(); vi.useFakeTimers();
  client.courses.mockResolvedValue(courses);
});
afterEach(() => { unmount(); vi.useRealTimers(); });

describe("measurement view request recovery", () => {
  it("finishes the initial courses-to-record read before enabling actions, and sends a double click only once", async () => {
    const list = deferred<typeof courses>();
    const record = deferred<MeasurementOverview>();
    const started = deferred<MeasurementOverview>();
    client.courses.mockReturnValue(list.promise);
    client.read.mockReturnValue(record.promise);
    client.start.mockReturnValue(started.promise);
    const loading = render();
    click(button(loading, "重新读取"));
    expect(client.courses).toHaveBeenCalledOnce();
    expect(client.read).not.toHaveBeenCalled();
    list.resolve(courses); await settle();
    expect(client.read).toHaveBeenCalledExactlyOnceWith("course-a");
    expect(select(render()).props.value).toBe("course-a");
    expect(select(render()).props.disabled).toBe(true);
    record.resolve(overview(null)); await settle();
    expect(button(render(), "启用测试").props.disabled).toBe(true);
    consent(render());
    const start = button(render(), "启用测试");
    expect(start.props.disabled).toBe(false);
    click(start); click(start); click(button(render(), "重新读取"));
    expect(client.start).toHaveBeenCalledOnce();
    expect(client.courses).toHaveBeenCalledOnce();
    started.resolve(overview()); await settle();
    expect(button(render(), "开始第一题").props.disabled).toBe(false);
  });

  it("recovers an empty course list after the user creates a course", async () => {
    client.courses.mockResolvedValueOnce([]);
    render(); await settle();
    expect(text(render())).toContain("先创建用于记录这次测试的课程");
    expect(client.read).not.toHaveBeenCalled();
    client.read.mockResolvedValue(overview(null));
    click(button(render(), "重新读取")); await settle();
    expect(client.read).toHaveBeenCalledExactlyOnceWith("course-a");
    expect(text(render())).toContain("启用测试");
  });

  it("offers a serialized recovery after the initial course list fails", async () => {
    client.courses.mockRejectedValueOnce(new Error("课程服务不可用"));
    render(); await settle();
    const failed = render();
    expect(componentProps(failed, LoadError).message).toContain("课程服务不可用");
    expect(client.read).not.toHaveBeenCalled();
    const recovery = deferred<typeof courses>();
    client.courses.mockReturnValue(recovery.promise);
    client.read.mockResolvedValue(overview());
    componentProps(failed, LoadError).onRetry!();
    componentProps(failed, LoadError).onRetry!();
    expect(client.courses).toHaveBeenCalledTimes(2);
    recovery.resolve(courses); await settle();
    expect(button(render(), "开始第一题").props.disabled).toBe(false);
  });

  it("remembers the selected course when its first record read fails", async () => {
    client.courses.mockResolvedValue([ { ...courses[0]!, archivedAt: "2026-10-16T00:00:00Z" }, courses[1]! ]);
    client.read.mockRejectedValueOnce(new Error("记录离线"));
    render(); await settle();
    const failed = render();
    expect(select(failed).props.value).toBe("course-b");
    expect(componentProps(failed, LoadError).message).toContain("先重新读取");
    expect(text(failed)).not.toContain("启用测试");
    client.read.mockResolvedValue(overview("course-b"));
    componentProps(failed, LoadError).onRetry!(); await settle();
    expect(client.read.mock.calls.map(call => call[0])).toEqual(["course-b", "course-b"]);
    expect(button(render(), "开始第一题").props.disabled).toBe(false);
  });

  it("blocks every write after an uncertain answer, keeps blocking on read failure, and retries the same intent key after recovery", async () => {
    const value = overview("course-a", [attempt]);
    await ready(value);
    client.act.mockRejectedValue(new TypeError("连接中断"));
    const onAction = componentProps(render(), MeasurementAttemptCard).onAction;
    onAction({ action: "answer", answer: "A" });
    onAction({ action: "answer", answer: "A" }); await settle();
    expect(client.act).toHaveBeenCalledOnce();
    const failed = render();
    expect(componentProps(failed, MeasurementAttemptCard).busy).toBe(true);
    expect(componentProps(failed, MeasurementReportPanel).busy).toBe(true);
    expect(button(failed, "暂停").props.disabled).toBe(true);
    onAction({ action: "answer", answer: "A" });
    click(button(failed, "暂停"));
    componentProps(failed, MeasurementReportPanel).onRetract(attempt.id, "误触");
    expect(client.act).toHaveBeenCalledOnce();
    expect(client.status).not.toHaveBeenCalled();
    client.read.mockRejectedValueOnce(new Error("读取也中断"));
    componentProps(failed, LoadError).onRetry!();
    const rereading = render();
    expect(elements(rereading).find(element => element.type === MeasurementAttemptCard)!.key).toBe(attempt.id);
    expect(componentProps(rereading, MeasurementAttemptCard).busy).toBe(true);
    await settle();
    expect(componentProps(render(), MeasurementAttemptCard).busy).toBe(true);
    expect(componentProps(render(), LoadError).message).toContain("读取也中断");
    componentProps(render(), LoadError).onRetry!(); await settle();
    const recovered = render();
    expect(componentProps(recovered, MeasurementAttemptCard).busy).toBe(false);
    expect(text(recovered)).not.toContain("答案已保存");
    client.act.mockResolvedValue(value);
    componentProps(recovered, MeasurementAttemptCard).onAction({ action: "answer", answer: "A" }); await settle();
    expect(client.act).toHaveBeenCalledTimes(2);
    expect(client.act.mock.calls[1]).toEqual(client.act.mock.calls[0]);
  });

  it("shows the actual saved answer after recovery without claiming the lost response succeeded", async () => {
    await ready(overview("course-a", [attempt]));
    client.act.mockRejectedValue(new TypeError("连接中断"));
    componentProps(render(), MeasurementAttemptCard).onAction({ action: "answer", answer: "A" }); await settle();
    const saved = { ...attempt, answer: "A", outcome: "correct" as const, answeredAt: "2026-10-16T00:01:00Z" };
    client.read.mockResolvedValue(overview("course-a", [saved]));
    componentProps(render(), LoadError).onRetry!(); await settle();
    const recovered = render();
    expect(elements(recovered).some(element => element.type === MeasurementAttemptCard)).toBe(false);
    expect(componentProps(recovered, MeasurementReportPanel).overview.attempts[0]!.answer).toBe("A");
    expect(text(recovered)).not.toContain("答案已保存");
    expect(button(recovered, "继续下一题").props.disabled).toBe(false);
  });

  it("serializes a reload against stale write handlers and refreshes the course archive state", async () => {
    const original = await ready();
    const list = deferred<typeof courses>();
    client.courses.mockReturnValue(list.promise);
    click(button(original, "重新读取"));
    click(button(original, "开始第一题"));
    click(button(original, "暂停"));
    click(button(original, "重新读取"));
    expect(client.courses).toHaveBeenCalledTimes(2);
    expect(client.next).not.toHaveBeenCalled();
    expect(client.status).not.toHaveBeenCalled();
    list.resolve([{ ...courses[0]!, archivedAt: "2026-10-16T00:00:00Z" }, courses[1]!]); await settle();
    const archived = render();
    expect(componentProps(archived, MeasurementReportPanel).readOnly).toBe(true);
    expect(text(archived)).toContain("课程已归档");
    expect(text(archived)).not.toContain("开始第一题");
  });

  it("switches to the course returned by a reload without triggering a duplicate read or leaving actions locked", async () => {
    await ready(overview(null));
    client.read.mockResolvedValue(overview("course-b"));
    click(button(render(), "重新读取")); await settle();
    const redirected = render();
    expect(select(redirected).props.value).toBe("course-b");
    expect(button(redirected, "开始第一题").props.disabled).toBe(false);
    render(); await settle();
    expect(client.courses).toHaveBeenCalledTimes(2);
    expect(client.read).toHaveBeenCalledTimes(2);
    client.next.mockResolvedValue(overview("course-b"));
    click(button(redirected, "开始第一题")); await settle();
    expect(client.next.mock.calls[0]![0].trialId).toBe("trial-course-b");
  });

  it("resets consent on a course change, rejects stale handlers from the old course, and retries a failed read for the new course", async () => {
    await ready(overview(null));
    consent(render());
    const old = render();
    client.read.mockRejectedValueOnce(new Error("新课程离线"));
    changeCourse(old, "course-b");
    click(button(old, "启用测试")); await settle();
    expect(select(render()).props.value).toBe("course-b");
    expect(client.start).not.toHaveBeenCalled();
    componentProps(render(), LoadError).onRetry!(); await settle();
    const changed = render();
    expect(client.read.mock.calls.map(call => call[0])).toEqual(["course-a", "course-b", "course-b"]);
    expect(button(changed, "启用测试").props.disabled).toBe(true);
    click(button(old, "启用测试"));
    expect(client.start).not.toHaveBeenCalled();
    consent(changed);
    client.start.mockResolvedValue(overview("course-b"));
    click(button(render(), "启用测试")); await settle();
    expect(client.start.mock.calls[0]![0].courseId).toBe("course-b");
  });

  it("discards a late initial course response after unmount", async () => {
    const list = deferred<typeof courses>();
    client.courses.mockReturnValue(list.promise);
    render(); unmount();
    const updates = hooks.updates;
    list.resolve(courses); await settle();
    expect(client.read).not.toHaveBeenCalled();
    expect(hooks.updates).toBe(updates);
  });

  it.each(["resolve", "reject"] as const)("discards a late read %s after unmount", async outcome => {
    const record = deferred<MeasurementOverview>();
    client.read.mockReturnValue(record.promise);
    render(); await settle(); unmount();
    const updates = hooks.updates;
    if (outcome === "resolve") record.resolve(overview()); else record.reject(new Error("late failure"));
    await settle();
    expect(hooks.updates).toBe(updates);
  });

  it.each(["resolve", "reject"] as const)("discards a late write %s after unmount", async outcome => {
    await ready();
    const next = deferred<MeasurementOverview>();
    client.next.mockReturnValue(next.promise);
    click(button(render(), "开始第一题")); unmount();
    const updates = hooks.updates;
    if (outcome === "resolve") next.resolve(overview()); else next.reject(new Error("late failure"));
    await settle();
    expect(hooks.updates).toBe(updates);
  });

  it("ignores the old course response during StrictMode cleanup and setup replay", async () => {
    const oldList = deferred<typeof courses>();
    client.courses.mockReturnValueOnce(oldList.promise);
    client.read.mockResolvedValue(overview("course-b"));
    render(); replayEffects(); await settle();
    oldList.resolve([{ ...courses[0]!, id: "stale-course" }]); await settle();
    expect(client.read).toHaveBeenCalledExactlyOnceWith("course-a");
    expect(select(render()).props.value).toBe("course-b");
    expect(button(render(), "开始第一题").props.disabled).toBe(false);
  });

  it("keeps the replacement read locked when an old StrictMode read finishes late", async () => {
    const oldRead = deferred<MeasurementOverview>();
    const newRead = deferred<MeasurementOverview>();
    client.read.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    render(); await settle(); replayEffects(); await settle();
    oldRead.resolve(overview("course-b")); await settle();
    click(button(render(), "重新读取"));
    expect(client.courses).toHaveBeenCalledTimes(2);
    expect(select(render()).props.disabled).toBe(true);
    newRead.resolve(overview()); await settle();
    expect(select(render()).props.value).toBe("course-a");
    expect(button(render(), "开始第一题").props.disabled).toBe(false);
  });
});
