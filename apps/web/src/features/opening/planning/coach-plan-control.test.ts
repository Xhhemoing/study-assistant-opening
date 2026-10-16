import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { CoachPlanAcceptance, PlanDraft } from "@aistudy/contracts";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? next(hooks.values[i]) : next; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useCallback: (value: unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { value: unknown; deps: unknown[] } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.values[i] = { value, deps };
    return (hooks.values[i] as { value: unknown }).value; },
  useEffect: (effect: () => unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.effects.push(() => {
      previous?.cleanup?.(); hooks.values[i] = { deps, cleanup: effect() }; }); },
}));
import { CoachPlanControl } from "./coach-plan-control";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render(component: () => ReactNode) { hooks.cursor = 0; const tree = component(); hooks.effects.splice(0).forEach(effect => effect()); return tree; }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function click(tree: ReactNode, label: string) {
  const button = elements(tree).find(element => element.type === "button" && text(element) === label);
  expect(button).toBeDefined(); (button!.props.onClick as () => void)();
}
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const draft: PlanDraft = { id, date: "2026-10-21", version: 0, baseVersion: 0, status: "draft", blocks: [], unscheduledTaskIds: [], origin: "auto_draft" };
const summary: CoachPlanAcceptance = { clientKey: `coach:${id}:0`, date: draft.date, acceptedVersion: 1,
  createdTaskIds: [id], scheduledMinutes: 25, undoAvailable: true, undone: false };
function api(enabled = false) { return { getAdaptivePrefs: vi.fn().mockResolvedValue({ prefs: { autonomy: "coach", coachBudgetMinutes: 60, courseGoals: {}, ...(enabled ? { coachAutoAcceptEnabled: true } : {}) }, saved: true, invalidStoredPrefs: false }),
  getCoachAcceptance: vi.fn().mockResolvedValue(null), acceptCoachPlan: vi.fn().mockResolvedValue({ draft: { ...draft, status: "accepted", version: 1 }, acceptance: summary }),
  undoCoachPlan: vi.fn().mockResolvedValue({ acceptedVersion: 2, blocks: [], closedTaskIds: [id], replayed: false }) }; }
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

it("never auto-accepts a historical coach preference without explicit opt-in", async () => {
  const client = api(), component = () => CoachPlanControl({ date: draft.date, draft, api: client, onChanged: vi.fn() });
  render(component); await settle(); render(component);
  expect(client.acceptCoachPlan).not.toHaveBeenCalled();
});
it("runs one idempotent POST after explicit opt-in and refreshes the queue", async () => {
  const client = api(true), changed = vi.fn(), component = () => CoachPlanControl({ date: draft.date, draft, api: client, onChanged: changed });
  render(component); await settle(); render(component); await settle();
  expect(client.acceptCoachPlan).toHaveBeenCalledExactlyOnceWith({ draftId: id, expectedDraftVersion: 0, clientKey: `coach:${id}:0` });
  expect(changed).toHaveBeenCalledOnce();
  expect(text(render(component))).toContain("新增1项任务");
});
it("reads after an unknown result without automatically repeating the write", async () => {
  const client = api(true); client.acceptCoachPlan.mockRejectedValue(new Error("network lost"));
  const component = () => CoachPlanControl({ date: draft.date, draft, api: client, onChanged: vi.fn() });
  render(component); await settle(); click(render(component), "重新核对安排"); await settle();
  expect(client.getCoachAcceptance).toHaveBeenCalledTimes(2);
  expect(client.acceptCoachPlan).toHaveBeenCalledTimes(1);
});
it("requires a second confirmation and binds undo to the accepted version", async () => {
  const client = api(); client.getCoachAcceptance.mockResolvedValue(summary);
  const changed = vi.fn(), component = () => CoachPlanControl({ date: draft.date, draft: null, api: client, onChanged: changed });
  render(component); await settle(); click(render(component), "撤销这次安排");
  expect(client.undoCoachPlan).not.toHaveBeenCalled();
  click(render(component), "确认撤销"); await settle();
  expect(client.undoCoachPlan).toHaveBeenCalledWith({ date: draft.date, acceptanceClientKey: summary.clientKey,
    expectedAcceptedVersion: 1, clientKey: expect.any(String) });
  expect(text(render(component))).toContain("已撤销");
  expect(changed).toHaveBeenCalledOnce();
});
