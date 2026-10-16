import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalReplanResult, PlanDraft } from "@aistudy/contracts";

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
import { LocalReplanCard } from "./local-replan-card";

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
const draft: PlanDraft = { id, date: "2026-10-16", version: 0, baseVersion: 1, status: "draft", blocks: [], unscheduledTaskIds: [] };
function api() { return { proposeLocalReplan: vi.fn().mockResolvedValue({ kind: "draft", draft }),
  acceptPlan: vi.fn().mockResolvedValue({ ...draft, status: "accepted", version: 2 }), rejectPlan: vi.fn().mockResolvedValue({ ...draft, status: "rejected" }) }; }
function props(client = api()) { return { api: client, date: draft.date, acceptedVersion: 1, blocks: [], tasks: [], reason: "missed_block" as const,
  timeZone: "UTC", dismissalKey: "workspace/owner/date/version/missed", onChanged: vi.fn().mockResolvedValue(undefined) }; }
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => vi.unstubAllGlobals());
it("requires a read after an unknown preview and recovers even when the accepted version is unchanged", async () => {
  const p = props(); p.api.proposeLocalReplan.mockRejectedValueOnce(new Error("network lost"));
  const component = () => LocalReplanCard(p);
  render(component); click(render(component), "预览局部重排"); await settle();
  expect(text(render(component))).toContain("重新读取当前安排");
  click(render(component), "重新读取当前安排"); await settle();
  expect(p.onChanged).toHaveBeenCalledTimes(1); expect(p.api.proposeLocalReplan).toHaveBeenCalledTimes(1);
  expect(text(render(component))).not.toContain("network lost");
  click(render(component), "预览局部重排"); await settle();
  expect(p.api.proposeLocalReplan).toHaveBeenCalledTimes(2);
  expect(p.api.proposeLocalReplan.mock.calls[0]![0].clientKey).not.toBe(p.api.proposeLocalReplan.mock.calls[1]![0].clientKey);
});
it("never repeats an unknown confirmation automatically and discards the old draft after a successful read", async () => {
  const p = props(); p.api.acceptPlan.mockRejectedValue(new Error("confirmation unknown"));
  const component = () => LocalReplanCard(p);
  render(component); click(render(component), "预览局部重排"); await settle();
  click(render(component), "确认局部重排"); await settle();
  click(render(component), "重新读取当前安排"); await settle();
  expect(p.api.acceptPlan).toHaveBeenCalledTimes(1);
  expect(text(render(component))).not.toContain("确认局部重排");
  expect(text(render(component))).toContain("预览局部重排");
});
it("keeps a dismissal across remounts within its owner/workspace/version scope", () => {
  const values = new Map<string,string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key,value) });
  const p = props(), component = () => LocalReplanCard(p);
  render(component); click(render(component), "暂不调整"); expect(render(component)).toBeNull();
  hooks.values=[]; render(component); expect(render(component)).toBeNull();
  const other = () => LocalReplanCard({ ...p, dismissalKey: "other-workspace/owner/date/version/missed" });
  render(other); expect(text(render(other))).toContain("预览局部重排");
});
it("ignores an old preview response after the accepted plan changes", async () => {
  let finish!: (value: LocalReplanResult) => void;
  const p = props(); p.api.proposeLocalReplan.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const component = () => LocalReplanCard(p);
  render(component); click(render(component), "预览局部重排");
  p.acceptedVersion = 2; render(component); render(component);
  finish({ kind: "draft", draft }); await settle();
  expect(text(render(component))).not.toContain("确认局部重排");
  expect(text(render(component))).toContain("预览局部重排");
});
