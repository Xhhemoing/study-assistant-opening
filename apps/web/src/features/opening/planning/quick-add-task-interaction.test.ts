import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));

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
  useContext: () => undefined,
}));

import { QuickAddTask } from "./quick-add-task";

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
  const result = elements(tree).find(item => item.type === "button" && text(item) === label);
  expect(result).toBeDefined();
  return result!;
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

it("preserves an unknown add through collapse and reopen, then retries the exact original request", async () => {
  const task = { id: "11111111-1111-4111-8111-111111111111", title: "整理错题", minutes: 25, dueAt: null, priority: 1, status: "pending" as const, version: 1 };
  const createTask = vi.fn().mockRejectedValueOnce(new TypeError("network lost")).mockResolvedValueOnce(task);
  const render = () => { hooks.cursor = 0; return QuickAddTask({ api: { createTask } }); };
  (button(render(), "快速添加任务").props.onClick as () => void)();
  const title = elements(render()).find(item => item.type === "input" && item.props.placeholder === "例如：整理错题")!;
  (title.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: task.title } });
  const form = elements(render()).find(item => item.type === "form")!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await settle();
  expect(createTask).toHaveBeenCalledTimes(1);
  const original = createTask.mock.calls[0]![0];

  (button(render(), "收起").props.onClick as () => void)();
  const collapsed = render();
  expect(text(collapsed)).toContain("继续核对添加结果");
  (button(collapsed, "继续核对添加结果").props.onClick as () => void)();
  const reopened = render();
  const preserved = elements(reopened).find(item => item.type === "input" && item.props.placeholder === "例如：整理错题")!;
  expect(preserved.props.value).toBe(task.title);
  expect(preserved.props.disabled).toBe(true);
  expect(createTask).toHaveBeenCalledTimes(1);
  (button(reopened, "重试提交（不会重复添加）").props.onClick as () => void)();
  await settle();
  expect(createTask).toHaveBeenCalledTimes(2);
  expect(createTask.mock.calls[1]![0]).toEqual(original);
  expect(text(render())).toContain("快速添加任务");
});
