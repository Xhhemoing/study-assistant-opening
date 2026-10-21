import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CurrentStudyContext } from "../assistant/current-study-context";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial;
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = next; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useEffect: (effect: () => unknown, deps: unknown[]) => { const i = hooks.cursor++, previous = hooks.values[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) hooks.effects.push(() => { previous?.cleanup?.(); hooks.values[i] = { deps, cleanup: effect() }; }); },
}));
import { selectedLessonExcerpt, SelectionAsk } from "./selection-ask";
const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const binding: CurrentStudyContext = { isQuestion: true, learningAttempt: { id } as NonNullable<CurrentStudyContext["learningAttempt"]>,
  context: { courseId: id, activityId: id, blockId: id, contentVersion: 2, attemptId: id, itemVersionId: id, purpose: "learning_help", label: "当前题" } };
function dom(text = "选中的真实题干", excluded = false, crossRegion = false) {
  const region = {} as Element;
  const start = { nodeType: 1, closest: (selector: string) => selector.startsWith("input") ? excluded ? {} : null : region } as unknown as Element;
  const end = { nodeType: 1, closest: (selector: string) => selector.startsWith("input") ? null : crossRegion ? {} : region } as unknown as Element;
  return { root: { contains: (value: unknown) => [start, end, region].includes(value as Element) } as HTMLElement,
    selection: { anchorNode: start, focusNode: end, isCollapsed: false, toString: () => text } };
}
let update: () => void = () => undefined;
beforeEach(() => {
  hooks.values = []; hooks.effects = [];
  vi.stubGlobal("document", { addEventListener: (_event: string, callback: () => void) => { update = callback; }, removeEventListener: vi.fn() });
});
afterEach(() => { for (const value of hooks.values) (value as { cleanup?: () => void } | null)?.cleanup?.(); vi.unstubAllGlobals(); });
function render(value: CurrentStudyContext = binding) { hooks.cursor = 0; const tree = SelectionAsk({ binding: value, children: "题干" }); hooks.effects.splice(0).forEach(effect => effect()); return tree; }
function find(node: ReactNode, type: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map(value => find(value, type)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  return node.type === type ? node.props : find(node.props.children as ReactNode, type);
}
function select(text?: string, value = binding) {
  const tree = render(value), scope = dom(text);
  (tree.props.ref as { current: HTMLElement }).current = scope.root;
  vi.stubGlobal("window", { getSelection: () => scope.selection }); update(); return render(value);
}
it("accepts only one visible instructional region, excluding answer fields and cross-region selections", () => {
  const valid = dom(); expect(selectedLessonExcerpt(valid.root, valid.selection)).toBe("选中的真实题干");
  for (const invalid of [dom("答案", true), dom("跨区域", false, true)]) expect(selectedLessonExcerpt(invalid.root, invalid.selection)).toBe("");
  expect(selectedLessonExcerpt(valid.root, { ...valid.selection, isCollapsed: true })).toBe("");
  expect(selectedLessonExcerpt({ contains: () => false } as unknown as HTMLElement, valid.selection)).toBe("");
});
it("opens the exact registered question with only the selected fragment changed", () => {
  const link = find(select(), "a")!; const href = new URL(String(link.href), "https://study.invalid");
  expect(href.pathname).toBe("/opening/assistant");
  for (const key of ["courseId", "activityId", "blockId", "attemptId", "itemVersionId"] as const) expect(href.searchParams.get(key)).toBe(id);
  expect(href.searchParams.get("contentVersion")).toBe("2"); expect(href.searchParams.get("fragment")).toBe("选中的真实题干");
  const preventDefault = vi.fn(); (link.onPointerDown as (event: { preventDefault: () => void }) => void)({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
});
it("does not carry a selected fragment into a changed question before a new selection", () => {
  select(); const next = { ...binding, context: { ...binding.context, attemptId: other } };
  expect(find(render(next), "a")).toBeUndefined();
});
it("retains the original-answer guard and refuses an oversized selection", () => {
  const blocked = { ...binding, learningAttempt: null };
  expect(find(select(undefined, blocked), "a")).toBeUndefined(); expect(find(render(blocked), "button")?.disabled).toBe(true);
  expect(find(select("x".repeat(4001)), "a")).toBeUndefined(); expect(find(render(), "button")?.disabled).toBe(true);
});
