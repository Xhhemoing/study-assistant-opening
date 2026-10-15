import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
vi.mock("../opening/timetable/semester-settings-form", () => ({ SemesterSettingsForm: () => null }));
vi.mock("../opening/timetable/timetable-import", () => ({ TimetableImport: () => null }));
vi.mock("../opening/teaching/preference-controls", () => ({ PreferenceControls: () => null }));
vi.mock("./settings-shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("./settings-shared")>(),
  fetchWorkspacePreferences: vi.fn(),
  putWorkspacePreferences: vi.fn(),
}));

import { SettingsView } from "./settings-view";
import { fetchWorkspacePreferences, putWorkspacePreferences } from "./settings-shared";

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
function render() { hooks.cursor = 0; return SettingsView(); }
function button(tree: ReactNode, label: string) {
  const result = elements(tree).find(item => item.type === "button" && text(item) === label);
  expect(result).toBeDefined();
  return result!;
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = [];
  vi.clearAllMocks();
});

it("does not offer default preferences for saving after a failed initial read", async () => {
  vi.mocked(fetchWorkspacePreferences).mockRejectedValueOnce(new Error("offline"));
  render();
  hooks.effects.shift()!();
  await settle();
  const failed = render();
  expect(text(failed)).toContain("设置暂时无法读取");
  expect(elements(failed).filter(item => item.type === "input" && item.props.type === "checkbox")).toHaveLength(0);
  expect(text(failed)).not.toContain("保存学习偏好");
  expect(putWorkspacePreferences).not.toHaveBeenCalled();

  vi.mocked(fetchWorkspacePreferences).mockResolvedValueOnce({ learningPreferences: { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false } });
  (button(failed, "重新读取").props.onClick as () => void)();
  await settle();
  const recovered = render();
  expect(elements(recovered).filter(item => item.type === "input" && item.props.checked === true)).toHaveLength(2);
  expect(text(recovered)).toContain("保存学习偏好");
});

it("locks preference inputs until the save resolves", async () => {
  const preferences = { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true };
  vi.mocked(fetchWorkspacePreferences).mockResolvedValueOnce({ learningPreferences: preferences });
  render();
  hooks.effects.shift()!();
  await settle();
  let resolveSave!: (value: { learningPreferences: typeof preferences }) => void;
  vi.mocked(putWorkspacePreferences).mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
  (button(render(), "保存学习偏好").props.onClick as () => void)();
  const saving = render();
  expect(elements(saving).filter(item => item.type === "input" && item.props.type === "checkbox").every(item => item.props.disabled === true)).toBe(true);
  expect(button(saving, "保存学习偏好").props.disabled).toBe(true);
  expect(putWorkspacePreferences).toHaveBeenCalledWith({ learningPreferences: preferences });
  resolveSave({ learningPreferences: preferences });
  await settle();
  expect(button(render(), "保存学习偏好").props.disabled).toBe(false);
  expect(text(render())).toContain("学习偏好已保存");
});
