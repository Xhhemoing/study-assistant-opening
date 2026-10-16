import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSED_CAPABILITIES, type OpeningCapabilities } from "@aistudy/config/public";
import type { OpeningApi } from "../opening/client/api";

const capsState = vi.hoisted(() => ({ adaptivePlanning: true }));

vi.mock("../opening/capabilities/capabilities-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../opening/capabilities/capabilities-provider")>();
  return {
    ...actual,
    useOpeningCapabilities: (): OpeningCapabilities => ({
      ...CLOSED_CAPABILITIES,
      adaptivePlanning: capsState.adaptivePlanning,
    }),
  };
});

const states: unknown[] = [];
const effects: Array<() => unknown> = [];
const cleanups: Array<() => void> = [];
let stateIndex = 0;

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => unknown) => {
    effects.push(effect);
  },
  useMemo: <T,>(factory: () => T) => factory(),
  useState: (initial: unknown) => {
    const index = stateIndex++;
    if (states[index] === undefined) {
      states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    }
    return [
      states[index],
      (value: unknown) => {
        states[index] =
          typeof value === "function" ? (value as (prev: unknown) => unknown)(states[index]) : value;
      },
    ];
  },
}));

import {
  CourseGoalForm,
  buildCourseGoalPatch,
  parseWeeklyMinutes,
  todayLocalDate,
} from "./course-goal-form";

const COURSE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type ControlProps = {
  children?: ReactNode;
  id?: string;
  type?: string;
  value?: string;
  role?: string;
  disabled?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void | Promise<void>;
};

function findControl(
  node: ReactNode,
  match: (element: ReactElement<ControlProps>) => boolean,
): ReactElement<ControlProps> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findControl(child, match);
      if (found) return found;
    }
    return;
  }
  if (!isValidElement<ControlProps>(node)) return;
  if (match(node)) return node;
  return findControl(node.props.children, match);
}

function findAll(
  node: ReactNode,
  match: (element: ReactElement<ControlProps>) => boolean,
  out: ReactElement<ControlProps>[] = [],
): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out);
    return out;
  }
  if (!isValidElement<ControlProps>(node)) return out;
  if (match(node)) out.push(node);
  findAll(node.props.children, match, out);
  return out;
}

function buttonLabel(el: ReactElement<ControlProps>): string {
  return JSON.stringify(el.props.children);
}

function mockApi(overrides: Partial<OpeningApi> = {}): OpeningApi {
  return {
    getAdaptivePrefs: vi.fn(async () => ({
      prefs: {
        autonomy: "copilot" as const,
        coachBudgetMinutes: 60,
        courseGoals: {},
      },
      saved: false,
      invalidStoredPrefs: false,
    })),
    patchAdaptivePrefs: vi.fn(async (patch) => ({
      prefs: {
        autonomy: "copilot" as const,
        coachBudgetMinutes: 60,
        courseGoals:
          patch.courseGoal?.goal == null
            ? {}
            : { [patch.courseGoal.courseId]: patch.courseGoal.goal },
      },
      saved: true,
      invalidStoredPrefs: false,
    })),
    ...overrides,
  } as unknown as OpeningApi;
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function resetHooks() {
  for (const cleanup of cleanups.splice(0)) cleanup();
  states.length = 0;
  effects.length = 0;
  stateIndex = 0;
}

function mount(api: OpeningApi) {
  stateIndex = 0;
  effects.length = 0;
  const tree = CourseGoalForm({ courseId: COURSE_ID, api });
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
  }
  return tree;
}

function rerender(api: OpeningApi) {
  stateIndex = 0;
  return CourseGoalForm({ courseId: COURSE_ID, api });
}

beforeEach(() => {
  capsState.adaptivePlanning = true;
  resetHooks();
});

afterEach(() => {
  resetHooks();
  vi.clearAllMocks();
});

describe("parseWeeklyMinutes / helpers", () => {
  it("accepts integers in 0–3000", () => {
    expect(parseWeeklyMinutes("0")).toEqual({ ok: true, value: 0 });
    expect(parseWeeklyMinutes("3000")).toEqual({ ok: true, value: 3000 });
    expect(parseWeeklyMinutes("120")).toEqual({ ok: true, value: 120 });
  });

  it("rejects 3001, negatives, and non-integers", () => {
    expect(parseWeeklyMinutes("3001").ok).toBe(false);
    expect(parseWeeklyMinutes("-1").ok).toBe(false);
    expect(parseWeeklyMinutes("12.5").ok).toBe(false);
    expect(parseWeeklyMinutes("").ok).toBe(false);
  });

  it("buildCourseGoalPatch wraps courseId and goal", () => {
    expect(buildCourseGoalPatch(COURSE_ID, null)).toEqual({
      courseGoal: { courseId: COURSE_ID, goal: null },
    });
    expect(
      buildCourseGoalPatch(COURSE_ID, { targetDate: "2026-12-01", weeklyMinutes: 200 }),
    ).toEqual({
      courseGoal: {
        courseId: COURSE_ID,
        goal: { targetDate: "2026-12-01", weeklyMinutes: 200 },
      },
    });
  });

  it("todayLocalDate formats YYYY-MM-DD", () => {
    expect(todayLocalDate(new Date(2026, 9, 15))).toBe("2026-10-15");
  });
});

describe("CourseGoalForm capability gate", () => {
  it("does not render when adaptivePlanning is false", () => {
    capsState.adaptivePlanning = false;
    const html = renderToStaticMarkup(
      createElement(CourseGoalForm, { courseId: COURSE_ID, api: mockApi() }),
    );
    expect(html).toBe("");
  });

  it("renders section when adaptivePlanning is true", () => {
    capsState.adaptivePlanning = true;
    const html = renderToStaticMarkup(
      createElement(CourseGoalForm, { courseId: COURSE_ID, api: mockApi() }),
    );
    expect(html).toContain("课程目标");
    expect(html).toContain('data-testid="course-goal-form"');
  });
});

describe("CourseGoalForm save / clear / validation", () => {
  it("saves with patch body matching form fields", async () => {
    const api = mockApi();
    mount(api);
    await flush();

    let tree = rerender(api);
    findControl(tree, (el) => el.props.id === "course-goal-target-date")?.props.onChange?.({
      target: { value: "2026-12-01" },
    });
    findControl(tree, (el) => el.props.id === "course-goal-weekly-minutes")?.props.onChange?.({
      target: { value: "210" },
    });

    tree = rerender(api);
    const saveBtn = findAll(tree, (el) => el.type === "button").find(
      (el) => buttonLabel(el).includes("保存") && !buttonLabel(el).includes("清除"),
    );
    expect(saveBtn).toBeTruthy();
    await saveBtn!.props.onClick?.();
    await flush();

    expect(api.patchAdaptivePrefs).toHaveBeenCalledWith({
      courseGoal: {
        courseId: COURSE_ID,
        goal: { targetDate: "2026-12-01", weeklyMinutes: 210 },
      },
    });
  });

  it("clear sends goal: null", async () => {
    const api = mockApi({
      getAdaptivePrefs: vi.fn(async () => ({
        prefs: {
          autonomy: "copilot" as const,
          coachBudgetMinutes: 60,
          courseGoals: {
            [COURSE_ID]: { targetDate: "2026-12-01", weeklyMinutes: 180 },
          },
        },
        saved: true,
        invalidStoredPrefs: false,
      })),
    });

    mount(api);
    await flush();

    const tree = rerender(api);
    const clearBtn = findAll(tree, (el) => el.type === "button").find((el) =>
      buttonLabel(el).includes("清除目标"),
    );
    expect(clearBtn).toBeTruthy();
    await clearBtn!.props.onClick?.();
    await flush();

    expect(api.patchAdaptivePrefs).toHaveBeenCalledWith({
      courseGoal: { courseId: COURSE_ID, goal: null },
    });
  });

  it.each(["3001", "-1"])(
    "does not call API when weeklyMinutes=%s and shows error",
    async (bad) => {
      const api = mockApi();
      mount(api);
      await flush();

      let tree = rerender(api);
      findControl(tree, (el) => el.props.id === "course-goal-weekly-minutes")?.props.onChange?.({
        target: { value: bad },
      });

      tree = rerender(api);
      const saveBtn = findAll(tree, (el) => el.type === "button").find(
        (el) => buttonLabel(el).includes("保存") && !buttonLabel(el).includes("清除"),
      );
      await saveBtn!.props.onClick?.();
      await flush();

      expect(api.patchAdaptivePrefs).not.toHaveBeenCalled();

      tree = rerender(api);
      const alert = findControl(tree, (el) => el.props.role === "alert");
      expect(alert).toBeTruthy();
      const alertText = renderToStaticMarkup(alert!);
      expect(alertText).toMatch(/每周投入分钟/);
    },
  );

  it("loads existing goal from prefs on mount", async () => {
    const api = mockApi({
      getAdaptivePrefs: vi.fn(async () => ({
        prefs: {
          autonomy: "copilot" as const,
          coachBudgetMinutes: 60,
          courseGoals: {
            [COURSE_ID]: { targetDate: "2026-11-20", weeklyMinutes: 90 },
          },
        },
        saved: true,
        invalidStoredPrefs: false,
      })),
    });

    mount(api);
    await flush();

    const tree = rerender(api);
    expect(findControl(tree, (el) => el.props.id === "course-goal-target-date")?.props.value).toBe(
      "2026-11-20",
    );
    expect(
      findControl(tree, (el) => el.props.id === "course-goal-weekly-minutes")?.props.value,
    ).toBe("90");
  });

  it("hides editors and save after getAdaptivePrefs rejects", async () => {
    const api = mockApi({
      getAdaptivePrefs: vi.fn(async () => {
        throw new Error("prefs unavailable");
      }),
    });

    mount(api);
    await flush();

    const tree = rerender(api);
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain("prefs unavailable");
    expect(html).toContain("重试");
    expect(findControl(tree, (el) => el.props.id === "course-goal-target-date")).toBeUndefined();
    expect(
      findControl(tree, (el) => el.props.id === "course-goal-weekly-minutes"),
    ).toBeUndefined();
    const saveBtn = findAll(tree, (el) => el.type === "button").find(
      (el) => buttonLabel(el).includes("保存") && !buttonLabel(el).includes("清除"),
    );
    expect(saveBtn).toBeUndefined();
    expect(
      findAll(tree, (el) => el.type === "button").find((el) => buttonLabel(el).includes("清除目标")),
    ).toBeUndefined();
  });

  it("retry after load failure reloads prefs and shows editors", async () => {
    let calls = 0;
    const api = mockApi({
      getAdaptivePrefs: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("prefs unavailable");
        return {
          prefs: {
            autonomy: "copilot" as const,
            coachBudgetMinutes: 60,
            courseGoals: {
              [COURSE_ID]: { targetDate: "2026-11-20", weeklyMinutes: 90 },
            },
          },
          saved: true,
          invalidStoredPrefs: false,
        };
      }),
    });

    mount(api);
    await flush();

    let tree = rerender(api);
    const retryBtn = findAll(tree, (el) => el.type === "button").find((el) =>
      buttonLabel(el).includes("重试"),
    );
    expect(retryBtn).toBeTruthy();
    retryBtn!.props.onClick?.();
    // Remount effects after reloadToken bump
    tree = mount(api);
    await flush();
    tree = rerender(api);
    expect(findControl(tree, (el) => el.props.id === "course-goal-target-date")?.props.value).toBe(
      "2026-11-20",
    );
    expect(
      findControl(tree, (el) => el.props.id === "course-goal-weekly-minutes")?.props.value,
    ).toBe("90");
    const saveBtn = findAll(tree, (el) => el.type === "button").find(
      (el) => buttonLabel(el).includes("保存") && !buttonLabel(el).includes("清除"),
    );
    expect(saveBtn).toBeTruthy();
  });

  it("successful load shows date/minutes inputs and save", async () => {
    const api = mockApi();
    mount(api);
    await flush();

    const tree = rerender(api);
    expect(findControl(tree, (el) => el.props.id === "course-goal-target-date")).toBeTruthy();
    expect(findControl(tree, (el) => el.props.id === "course-goal-weekly-minutes")).toBeTruthy();
    const saveBtn = findAll(tree, (el) => el.type === "button").find(
      (el) => buttonLabel(el).includes("保存") && !buttonLabel(el).includes("清除"),
    );
    expect(saveBtn).toBeTruthy();
  });
});
