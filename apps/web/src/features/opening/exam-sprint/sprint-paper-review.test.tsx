// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseRouteSnapshot } from "@aistudy/contracts";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { writePaperReviewSessionState } from "../shared/paper-review-session";
import { SprintPaperReviewPanel } from "./sprint-paper-review";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const IDENTITY = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
};
const COURSE_1 = "33333333-3333-4333-8333-333333333331";
const REQ_1 = "55555555-5555-4555-8555-555555555551";
const SKILL_1 = "66666666-6666-4666-8666-666666666661";

function makeSnapshot(): CourseRouteSnapshot {
  return {
    courseId: COURSE_1,
    scopeState: "confirmed",
    requirements: [
      {
        requirement: {
          id: REQ_1,
          courseId: COURSE_1,
          stableSkillId: SKILL_1,
          knowledgeNodeId: null,
          requirementKey: "req:series",
          title: "比值审敛法判别正项级数",
          position: 0,
          mandatory: true,
          goalIds: [],
          prerequisiteIds: [],
          sourceRefs: [],
          verification: {
            kind: "manual",
            status: "missing",
            exerciseKeys: [],
            rubric: null,
            missingReasons: [],
          },
          revision: 2,
          lifecycle: "active",
          origin: "confirmed",
          approvedAt: "2026-11-18T00:00:00.000Z",
        },
        status: "unobserved",
        observationId: null,
        missingReasons: [],
        sourcesAvailable: true,
      },
    ],
    suggestions: [],
    summary: { total: 1, mandatory: 1, verified: 0, blocked: 0 },
    materials: [],
    currentActivity: null,
    currentRoute: null,
    observationId: null,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButton(label: string, scope: ParentNode): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(item =>
    item.textContent?.includes(label),
  );
  if (!button) {
    throw new Error(`Button containing "${label}" not found`);
  }
  return button;
}

describe("SprintPaperReviewPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.sessionStorage.clear();
    dispose = publishVerifiedSessionIdentity(IDENTITY);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    dispose?.();
    dispose = null;
  });

  it("ignores a late route response after a course switch and retains the new course's checklist", async () => {
    const nextCourse = "33333333-3333-4333-8333-333333333332";
    const first = makeSnapshot();
    const next = makeSnapshot();
    next.courseId = nextCourse;
    next.requirements[0]!.requirement = {
      ...next.requirements[0]!.requirement, courseId: nextCourse, title: "新课程要求", revision: 9,
    };
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<CourseRouteSnapshot>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(next);
    let resolveFirst: (snapshot: CourseRouteSnapshot) => void = () => { throw new Error("Read not started"); };
    await act(async () => root.render(createElement(SprintPaperReviewPanel, {
      courseId: COURSE_1, routeClient: { read }, defaultOpen: true,
    })));
    await act(async () => root.render(createElement(SprintPaperReviewPanel, {
      courseId: nextCourse, routeClient: { read }, defaultOpen: true,
    })));
    await act(async () => resolveFirst(first));
    expect(container.textContent).toContain("新课程要求");
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true);
    expect(container.textContent).toContain("已标 1 项");
  });

  it("keeps the collapsed count hidden until revisions are verified and supports toggle, undo, and a new round", async () => {
    writePaperReviewSessionState(
      { kind: "course", id: COURSE_1 },
      {
        version: 1,
        roundNumber: 1,
        updatedAt: "2026-11-19T00:00:00.000Z",
        items: {
          [REQ_1]: { requirementRevision: 2, markedAt: "2026-11-19T00:00:00.000Z" },
        },
      },
      IDENTITY,
    );

    const read = vi.fn().mockResolvedValue(makeSnapshot());
    await act(async () => {
      root.render(createElement(SprintPaperReviewPanel, { courseId: COURSE_1, routeClient: { read } }));
    });
    await flush();

    expect(container.textContent).not.toContain("已标");
    expect(read).not.toHaveBeenCalled();
    const map = container.querySelector<HTMLAnchorElement>("a")!;
    expect(map.pathname).toBe("/opening/map");
    expect(new URL(map.href).searchParams.get("context")).toBe("course");
    expect(new URL(map.href).searchParams.get("id")).toBe(`course/${COURSE_1}`);

    await act(async () => {
      findButton("展开纸上核对", container).click();
    });
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
    expect(container.textContent).toContain("本轮纸上已过，仍待线上独立验证");

    await act(async () => {
      checkbox.click();
    });
    await flush();
    expect(checkbox.checked).toBe(false);
    expect(container.textContent).toContain("第 1 轮 · 已标 0 项");

    await act(async () => {
      findButton("撤销上一步", container).click();
    });
    await flush();
    expect(checkbox.checked).toBe(true);

    await act(async () => {
      findButton("开启新一轮纸上核对", container).click();
    });
    await flush();
    expect(container.textContent).toContain("第 2 轮 · 已标 0 项");
    expect(findButton("开启新一轮纸上核对", container).disabled).toBe(true);
  });
});
