import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const caps = vi.hoisted(() => ({ adaptivePlanning: false }));
vi.mock("../opening/capabilities/capabilities-provider", () => ({ useOpeningCapabilities: () => caps }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
const states: unknown[] = [];
let index = 0;
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: () => undefined,
  useState: () => [states[index++], vi.fn()],
}));

import { CourseDetail, type CourseDetailSurface } from "./course-detail";
import { CourseGoalForm } from "./course-goal-form";
import { CourseSprintMode } from "./course-sprint-mode";

function contains(node: ReactNode, match: (type: unknown, children: ReactNode) => boolean): boolean {
  if (Array.isArray(node)) return node.some(child => contains(child, match));
  if (!isValidElement<{ children?: ReactNode }>(node)) return false;
  return match(node.type, node.props.children) || contains(node.props.children, match);
}

function render(surface: CourseDetailSurface = "opening", mode?: "sprint") {
  index = 0;
  return CourseDetail({ id: "course", surface, mode });
}

beforeEach(() => {
  caps.adaptivePlanning = false;
  states.splice(0, states.length, { id: "course", title: "数学", description: "" }, [], false, "", 0);
});

describe("course detail planning capability", () => {
  it("opens sprint only after this exact course has been read successfully", () => {
    expect(contains(render("opening", "sprint"), type => type === CourseSprintMode)).toBe(true);
    states[0] = { id: "other", title: "另一课程" };
    expect(contains(render("opening", "sprint"), type => type === CourseSprintMode)).toBe(false);
    states[0] = null; states[3] = "课程读取失败";
    expect(contains(render("opening", "sprint"), type => type === CourseSprintMode)).toBe(false);
  });
  it("hides the entire goal section while capabilities are closed", () => {
    const tree = render();
    expect(contains(tree, (type, children) => type === "h2" && children === "目标与学习安排")).toBe(false);
    expect(contains(tree, type => type === CourseGoalForm)).toBe(false);
    expect(contains(tree, (type, children) => type === "h2" && children === "学习进展与记录")).toBe(true);
  });

  it("shows the goal section and form only after adaptive planning is enabled", () => {
    caps.adaptivePlanning = true;
    const tree = render();
    expect(contains(tree, (type, children) => type === "h2" && children === "目标与学习安排")).toBe(true);
    expect(contains(tree, type => type === CourseGoalForm)).toBe(true);
    caps.adaptivePlanning = false;
    const closed = render();
    expect(contains(closed, type => type === CourseGoalForm)).toBe(false);
    expect(contains(closed, (type, children) => type === "h2" && children === "目标与学习安排")).toBe(false);
  });

  it("keeps the legacy surface without Opening goal controls", () => {
    caps.adaptivePlanning = true;
    const tree = render("learn");
    expect(contains(tree, type => type === CourseGoalForm)).toBe(false);
    expect(contains(tree, (type, children) => type === "h2" && children === "目标与学习安排")).toBe(false);
  });
});
