import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { CourseSummary } from "./course-model";

const { listState } = vi.hoisted(() => ({ listState: { rows: [] as CourseSummary[], loading: false, error: "", reload: vi.fn() } }));
const states: unknown[] = [];
let stateIndex = 0;

vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useMemo: <T,>(calculate: () => T) => calculate(),
  useState: (initial: unknown) => {
    const index = stateIndex++;
    if (states[index] === undefined) states[index] = initial;
    return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  },
}));
vi.mock("../design/use-json-list", async importOriginal => ({
  ...await importOriginal<typeof import("../design/use-json-list")>(),
  useJsonList: () => listState,
}));

import { CourseList } from "./course-list";

type ControlProps = { children?: ReactNode; action?: ReactNode; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void; "aria-label"?: string };

function findControl(node: ReactNode, match: (control: ReactElement<ControlProps>) => boolean): ReactElement<ControlProps> | undefined {
  if (Array.isArray(node)) return node.map(child => findControl(child, match)).find(Boolean);
  if (!isValidElement<ControlProps>(node)) return;
  return match(node) ? node : findControl(node.props.children, match) ?? findControl(node.props.action, match);
}

function renderList() { stateIndex = 0; return CourseList({ opening: true }); }

beforeEach(() => {
  states.length = 0;
  stateIndex = 0;
  listState.rows = [];
  listState.loading = false;
  listState.error = "";
});

it("keeps Opening course creation inside the Opening route", () => {
  const html = renderToStaticMarkup(createElement(CourseList, { opening: true }));
  expect(html).toContain("/opening/courses/new");
  expect(html).not.toContain("/learn/courses/new");
});

it("clears an unmatched search and restores courses in the current category", () => {
  listState.rows = [
    { id: "active", title: "进行中数学", slug: "math", description: "", createdAt: "2026-10-15", updatedAt: "2026-10-15" },
    { id: "archived", title: "归档物理", slug: "physics", description: "", archivedAt: "2026-10-15", createdAt: "2026-10-15", updatedAt: "2026-10-15" },
  ];
  let tree = renderList();
  findControl(tree, control => control.type === "button" && control.props.children === "已归档")?.props.onClick?.();
  tree = renderList();
  findControl(tree, control => control.props["aria-label"] === "搜索课程")?.props.onChange?.({ target: { value: "没有这个课程" } });
  tree = renderList();
  expect(renderToStaticMarkup(tree)).toContain("没有匹配的课程");
  const clear = findControl(tree, control => control.type === "button" && control.props.children === "清空搜索");
  expect(clear).toBeDefined();
  clear?.props.onClick?.();
  const html = renderToStaticMarkup(renderList());
  expect(html).toContain("归档物理");
  expect(html).not.toContain("进行中数学");
  expect(html).not.toContain("清空搜索");
});

it("keeps the first-course action for a truly empty workspace", () => {
  const html = renderToStaticMarkup(renderList());
  expect(html).toContain("创建第一门课程");
  expect(html).not.toContain("清空搜索");
});
