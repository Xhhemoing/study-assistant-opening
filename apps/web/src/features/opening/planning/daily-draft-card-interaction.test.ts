import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { OpeningAdaptivePrefsResponse, PlanDraft } from "@aistudy/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise component handlers and asynchronous state changes in Node, without a browser.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useMemo: (create: () => unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.values[index] as { deps: unknown[]; value: unknown } | undefined;
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) hooks.values[index] = { deps, value: create() };
    return (hooks.values[index] as { value: unknown }).value;
  },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.values[index] as { deps: unknown[]; value: unknown } | undefined;
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) hooks.values[index] = { deps, value: callback };
    return (hooks.values[index] as { value: unknown }).value;
  },
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.values[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hooks.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.values[index] = { deps, cleanup }; });
    }
  },
}));

import { DailyDraftCard } from "./daily-draft-card";
import { AdaptiveDraftDetails, AdaptiveDraftPreview } from "./adaptive-draft-preview";
import { AutonomySwitcher } from "./autonomy-switcher";
import { OpeningApiError } from "../client/api";
import { SuggestionRejectionControl } from "./suggestion-rejection-control";

type Element = ReactElement<Record<string, unknown>>;
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
function button(tree: ReactNode, label: string): Element {
  const found = elements(tree).find((element) => element.type === "button" && text(element) === label);
  expect(found).toBeDefined(); return found!;
}
function click(element: Element) { (element.props.onClick as () => void)(); }
function render(component: () => ReactNode): ReactNode {
  hooks.cursor = 0;
  const tree = component();
  const effects = hooks.effects.splice(0);
  effects.forEach((effect) => effect());
  return tree;
}
async function settle() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
function preview(tree: ReactNode) {
  return elements(tree).find((element) => element.type === AdaptiveDraftPreview)!.props as Parameters<typeof AdaptiveDraftPreview>[0];
}
const sample: PlanDraft = {
  id: "draft-old", date: "2026-10-16", version: 1, baseVersion: 0, status: "draft",
  blocks: ["a", "b"].map((taskId) => ({ taskId, start: "2026-10-16T12:00:00Z", end: "2026-10-16T12:25:00Z", reason: "练习巩固" })),
  suggestedTasks: ["a", "b", "blocked"].map((id) => ({ id, key: `suggestion-${id}`, title: `巩固 ${id}`, minutes: 25, kind: "weak_skill", courseId: null, skillLabel: id, reasonCode: "weak_skill", reason: "练习巩固" })),
  unscheduledTaskIds: ["blocked"],
};
function api() {
  return { acceptPlan: vi.fn().mockResolvedValue({ ...sample, status: "accepted" }), rejectPlan: vi.fn(), proposePlan: vi.fn(), getPlanningSettings: vi.fn(), putPlanningSettings: vi.fn(), createTask: vi.fn() };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

describe("daily draft interactions", () => {
  it("records explicit feedback once and removes a persisted rejected key from the acceptance selection", async () => {
    const client = { ...api(), submitSuggestionFeedback: vi.fn() };
    let resolve!: (value: { feedbackId: string; draft: PlanDraft }) => void;
    client.submitSuggestionFeedback.mockReturnValue(new Promise(done => { resolve = done; }));
    const component = () => DailyDraftCard({ api: client, date: sample.date, dailyDraft: sample, adaptivePlanning: true });
    preview(render(component)).onSelectionChange(["suggestion-a"]);
    expect(client.submitSuggestionFeedback).not.toHaveBeenCalled();
    const handler = preview(render(component)).onRejectSuggestion!;
    void handler("suggestion-a", "too_hard"); void handler("suggestion-a", "too_hard");
    expect(client.submitSuggestionFeedback).toHaveBeenCalledOnce();
    expect(client.submitSuggestionFeedback.mock.calls[0]![0]).toMatchObject({ draftId: sample.id, expectedDraftVersion: 1,
      suggestionKey: "suggestion-a", reason: "too_hard" });
    expect(button(render(component), "正在处理…").props.disabled).toBe(true);
    resolve({ feedbackId: "receipt", draft: { ...sample, version: 2, rejectedSuggestedKeys: ["suggestion-a"] } }); await settle();
    expect(preview(render(component)).draft.version).toBe(2);
    expect(preview(render(component)).selectedKeys).toEqual([]);
    click(button(render(component), "确认")); await settle();
    expect(client.acceptPlan.mock.calls[0]![0].acceptSuggestedKeys).toEqual([]);
  });

  it("blocks writes after uncertain feedback until a real reread and reuses the same intent key", async () => {
    const client = { ...api(), submitSuggestionFeedback: vi.fn().mockRejectedValue(new TypeError("network lost")) };
    const onRefreshSuggestions = vi.fn().mockResolvedValue(undefined);
    const component = () => DailyDraftCard({ api: client, date: sample.date, dailyDraft: sample, adaptivePlanning: true, onRefreshSuggestions });
    await preview(render(component)).onRejectSuggestion!("suggestion-a"); await settle();
    expect(button(render(component), "确认").props.disabled).toBe(true);
    await preview(render(component)).onRejectSuggestion!("suggestion-a");
    expect(client.submitSuggestionFeedback).toHaveBeenCalledOnce();
    click(button(render(component), "刷新草案")); await settle();
    await preview(render(component)).onRejectSuggestion!("suggestion-a"); await settle();
    expect(client.submitSuggestionFeedback).toHaveBeenCalledTimes(2);
    expect(client.submitSuggestionFeedback.mock.calls[1]![0]).toEqual(client.submitSuggestionFeedback.mock.calls[0]![0]);
  });

  it("discards feedback responses after a different draft has arrived", async () => {
    const client = { ...api(), submitSuggestionFeedback: vi.fn() };
    let resolve!: (value: { feedbackId: string; draft: PlanDraft }) => void;
    client.submitSuggestionFeedback.mockReturnValue(new Promise(done => { resolve = done; }));
    const props = { api: client, date: sample.date, dailyDraft: sample, adaptivePlanning: true };
    const component = () => DailyDraftCard(props);
    void preview(render(component)).onRejectSuggestion!("suggestion-a");
    props.dailyDraft = { ...sample, id: "new-draft", version: 4 }; render(component); render(component);
    resolve({ feedbackId: "receipt", draft: { ...sample, version: 2, rejectedSuggestedKeys: ["suggestion-a"] } }); await settle();
    expect(preview(render(component)).draft.id).toBe("new-draft");
  });
  it("submits the checked suggestions once even when confirm is clicked twice before rerender", async () => {
    const client = api();
    let resolve!: (draft: PlanDraft) => void;
    client.acceptPlan.mockReturnValue(new Promise((done) => { resolve = done; }));
    const props = { api: client, date: sample.date, dailyDraft: sample, adaptivePlanning: true };
    const component = () => DailyDraftCard(props);
    const details = AdaptiveDraftDetails(preview(render(component)));
    const checkboxes = elements(details).filter((element) => element.type === "input");
    expect(checkboxes[2]!.props.disabled).toBe(true);
    (checkboxes[1]!.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: false } });
    const confirm = button(render(component), "确认");
    click(confirm); click(confirm);
    expect(client.acceptPlan).toHaveBeenCalledOnce();
    expect(client.acceptPlan.mock.calls[0]![0].acceptSuggestedKeys).toEqual(["suggestion-a"]);
    resolve({ ...sample, status: "accepted" }); await settle();
    expect(render(component)).toBeNull();
  });

  it("preserves deselection on failure and retries the identical request with the same key", async () => {
    const client = api(); client.acceptPlan.mockRejectedValueOnce(new TypeError("network lost"));
    const component = () => DailyDraftCard({ api: client, date: sample.date, dailyDraft: sample, adaptivePlanning: true });
    preview(render(component)).onSelectionChange([]);
    click(button(render(component), "确认")); await settle();
    const failed = render(component);
    expect(preview(failed).selectedKeys).toEqual([]);
    expect(text(failed)).toContain("network lost");
    click(button(failed, "确认")); await settle();
    expect(client.acceptPlan.mock.calls[1]![0]).toEqual(client.acceptPlan.mock.calls[0]![0]);
    expect(client.acceptPlan.mock.calls[1]![0].acceptSuggestedKeys).toEqual([]);
  });

  it.each(["accept", "adjust", "reject"] as const)("ignores a late %s result after a different draft arrives", async (kind) => {
    const client = api();
    let resolve!: (draft: PlanDraft) => void;
    const method = kind === "accept" ? client.acceptPlan : kind === "adjust" ? client.proposePlan : client.rejectPlan;
    method.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onChanged = vi.fn();
    const props = { api: client, date: sample.date, dailyDraft: sample, adaptivePlanning: true, onChanged };
    const component = () => DailyDraftCard(props);
    click(button(render(component), kind === "accept" ? "确认" : kind === "adjust" ? "调整" : "拒绝"));
    props.dailyDraft = { ...sample, id: "draft-new", version: 2 };
    render(component);
    expect(preview(render(component)).draft.id).toBe("draft-new");
    resolve({ ...sample, id: "late-result" }); await settle();
    expect(preview(render(component)).draft.id).toBe("draft-new");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("rereads after a stale-version conflict while preserving the user's choices", async () => {
    const client = api(); client.acceptPlan.mockRejectedValue(new OpeningApiError(409, "changed", "CONFLICT", "stale_version"));
    const onChanged = vi.fn();
    const component = () => DailyDraftCard({ api: client, date: sample.date, dailyDraft: sample, adaptivePlanning: true, onChanged });
    preview(render(component)).onSelectionChange(["suggestion-b"]);
    click(button(render(component), "确认")); await settle();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(preview(render(component)).selectedKeys).toEqual(["suggestion-b"]);
    expect(text(render(component))).toContain("请重新读取后再确认");
    expect(text(render(component))).not.toContain("已为你刷新");
  });

  it("waits for the new-suggestion click and prevents repeated refresh requests", async () => {
    let resolve!: () => void;
    const onRefreshSuggestions = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const client = api();
    const component = () => DailyDraftCard({ api: client, date: sample.date, dailyDraft: sample, adaptivePlanning: true, hasNewerSuggestion: true, onRefreshSuggestions });
    const tree = render(component);
    expect(onRefreshSuggestions).not.toHaveBeenCalled();
    click(button(tree, "有新建议 · 点击更新")); click(button(tree, "有新建议 · 点击更新"));
    expect(onRefreshSuggestions).toHaveBeenCalledOnce();
    resolve(); await settle();
  });

  it("offers a real refresh after unavailable materials without dropping the selection on failure", async () => {
    const client = api(); client.acceptPlan.mockRejectedValue(new OpeningApiError(409, "unavailable", "CONFLICT", "source_unavailable"));
    const onRefreshSuggestions = vi.fn().mockRejectedValue(new Error("refresh unavailable"));
    const component = () => DailyDraftCard({ api: client, date: sample.date, dailyDraft: sample, adaptivePlanning: true, onRefreshSuggestions });
    preview(render(component)).onSelectionChange(["suggestion-a"]);
    click(button(render(component), "确认")); await settle();
    expect(text(render(component))).not.toContain("已移除");
    click(button(render(component), "刷新草案")); await settle();
    expect(onRefreshSuggestions).toHaveBeenCalledOnce();
    expect(preview(render(component)).selectedKeys).toEqual(["suggestion-a"]);
    expect(text(render(component))).toContain("refresh unavailable");
  });
});

it("does not send feedback when the optional reason panel is merely opened then cancelled", async () => {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const component = () => SuggestionRejectionControl({ disabled: false, onConfirm });
  click(button(render(component), "不适合我"));
  expect(text(render(component))).toContain("今天不再推荐");
  click(button(render(component), "取消"));
  expect(onConfirm).not.toHaveBeenCalled();
  click(button(render(component), "不适合我"));
  click(button(render(component), "确认反馈")); await settle();
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(undefined);
});

describe("arrangement mode", () => {
  const result: OpeningAdaptivePrefsResponse = { prefs: { autonomy: "copilot", coachBudgetMinutes: 60, courseGoals: {} }, saved: true, invalidStoredPrefs: false };
  it("saves manual mode once and refreshes only after persistence succeeds", async () => {
    const client = { getAdaptivePrefs: vi.fn().mockResolvedValue(result), patchAdaptivePrefs: vi.fn().mockResolvedValue({ ...result, prefs: { ...result.prefs, autonomy: "manual" } }) };
    const onChanged = vi.fn();
    const component = () => AutonomySwitcher({ api: client, onChanged });
    render(component); await settle();
    const manual = button(render(component), "手工");
    click(manual); click(manual);
    expect(client.patchAdaptivePrefs).toHaveBeenCalledExactlyOnceWith({ autonomy: "manual" });
    expect(onChanged).not.toHaveBeenCalled();
    await settle();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(button(render(component), "手工").props["aria-pressed"]).toBe(true);
  });

  it("keeps a historical coach preference advisory until explicit opt-in", async () => {
    const client = { getAdaptivePrefs: vi.fn().mockResolvedValue({ ...result, prefs: { ...result.prefs, autonomy: "coach" } }), patchAdaptivePrefs: vi.fn() };
    const component = () => AutonomySwitcher({ api: client, onChanged: vi.fn() });
    render(component); await settle();
    const tree = render(component);
    expect(text(tree)).toContain("仍需逐次确认");
    expect(elements(tree).filter((item) => item.type === "button").map(text)).toEqual(["手工", "副驾驶", "启用教练"]);
    expect(client.patchAdaptivePrefs).not.toHaveBeenCalled();
  });

  it("enables coach only after an explicit click with the visible time budget, once", async () => {
    const client = { getAdaptivePrefs: vi.fn().mockResolvedValue(result), patchAdaptivePrefs: vi.fn().mockResolvedValue({
      ...result, prefs: { ...result.prefs, autonomy: "coach", coachBudgetMinutes: 45, coachAutoAcceptEnabled: true },
    }) };
    const onChanged = vi.fn();
    const component = () => AutonomySwitcher({ api: client, onChanged });
    render(component); await settle();
    const input = elements(render(component)).find(node => node.type === "input")!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "45" } });
    const enable = button(render(component), "启用教练"); click(enable); click(enable); await settle();
    expect(client.patchAdaptivePrefs).toHaveBeenCalledExactlyOnceWith({ autonomy: "coach", coachBudgetMinutes: 45, coachAutoAcceptEnabled: true });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("keeps the saved mode and does not refresh when saving fails", async () => {
    const client = { getAdaptivePrefs: vi.fn().mockResolvedValue(result), patchAdaptivePrefs: vi.fn().mockRejectedValue(new Error("save unavailable")) };
    const onChanged = vi.fn();
    const component = () => AutonomySwitcher({ api: client, onChanged });
    render(component); await settle();
    click(button(render(component), "手工")); await settle();
    expect(button(render(component), "副驾驶").props["aria-pressed"]).toBe(true);
    expect(text(render(component))).toContain("save unavailable");
    expect(onChanged).not.toHaveBeenCalled();
  });
});
