// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeachingActivity } from "@aistudy/contracts";
import { probeMaterialsAvailability } from "@aistudy/domain";
import { currentCourseActivity } from "../courses/course-study-model";
import { TodayResumeBody } from "../planning/today-resume-view";
import { TodayDashboard } from "../planning/today-dashboard";
import type { OpeningApi } from "../client/api";
import {
  buildStartLearningCreateInput,
  canRequestTeachingCompile,
  isTeachingActivityPlaceholder,
  pickCurrentTeachingActivity,
  resolveWritingActivityTarget,
  teachingActivityContentHonesty,
  teachingActivityGenerateStatusLabel,
  todayActivityCtaLabel,
} from "./today-activity";

const base: TeachingActivity = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: "33333333-3333-4333-8333-333333333333",
  courseId: null,
  status: "active",
  generateStatus: "queued",
  intentKind: "topic",
  intentSummary: "今日主题学习",
  sourceIds: [],
  pathVersion: 1,
  contentVersion: 0,
  clientKey: "today-topic:2026-10-11",
  createdAt: "2026-10-11T01:00:00.000Z",
  updatedAt: "2026-10-11T02:00:00.000Z",
};

it("starts a task with stable identity across days and stores its taskId in createIntent", () => {
  const taskId = "77777777-7777-4777-8777-777777777777";
  const courseId = "88888888-8888-4888-8888-888888888888";
  const first = buildStartLearningCreateInput({ localDate: "2026-10-15", taskId, courseId, courseTitle: "矩阵练习" });
  const next = buildStartLearningCreateInput({ localDate: "2026-10-16", taskId, courseId, courseTitle: "矩阵练习" });
  expect(first).toEqual(next);
  expect(first).toMatchObject({ clientKey: `task:${taskId}`, courseId, intentSummary: "矩阵练习", createIntent: { taskId } });
});

it("picks the newest active or paused activity and ignores completed", () => {
  const olderActive = { ...base, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", updatedAt: "2026-10-11T01:00:00.000Z" };
  const paused = {
    ...base,
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status: "paused" as const,
    updatedAt: "2026-10-11T03:00:00.000Z",
  };
  const done = {
    ...base,
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    status: "completed" as const,
    updatedAt: "2026-10-11T04:00:00.000Z",
  };
  expect(pickCurrentTeachingActivity([olderActive, paused, done])?.id).toBe(paused.id);
  expect(pickCurrentTeachingActivity([done])).toBeNull();
  expect(todayActivityCtaLabel(paused)).toBe("继续学习");
  expect(todayActivityCtaLabel(null)).toBe("开始学习");
});

it("builds idempotent resume or topic create input with honest Chinese summary", () => {
  const resume = buildStartLearningCreateInput({
    localDate: "2026-10-11",
    continueTitle: "线性代数答疑",
    continueConversationId: "11111111-1111-4111-8111-111111111111",
  });
  expect(resume.intentKind).toBe("resume");
  expect(resume.intentSummary).toBe("继续：线性代数答疑");
  expect(resume.clientKey).toContain("today-resume:2026-10-11:");
  const topic = buildStartLearningCreateInput({ localDate: "2026-10-11" });
  expect(topic).toMatchObject({
    clientKey: "today-topic:2026-10-11",
    intentKind: "topic",
    intentSummary: "今日主题学习",
  });
});

it("attaches the continued conversation's materials as sourceIds outside createIntent", () => {
  const a = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const b = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const input = buildStartLearningCreateInput({
    localDate: "2026-10-13",
    continueTitle: "秩与零空间",
    continueConversationId: "11111111-1111-4111-8111-111111111111",
    continueSourceIds: [a, b, a],
  });
  expect(input.sourceIds).toEqual([b, a]);
  expect(input.createIntent).not.toHaveProperty("sourceIds");
  const bare = buildStartLearningCreateInput({
    localDate: "2026-10-13",
    continueTitle: "秩与零空间",
    continueConversationId: "11111111-1111-4111-8111-111111111111",
    continueSourceIds: [],
  });
  expect(bare).not.toHaveProperty("sourceIds");
});

it("offers generation only when nothing is running and no usable content exists", () => {
  expect(canRequestTeachingCompile({ generateStatus: "ready", contentVersion: 0 })).toBe(true);
  expect(canRequestTeachingCompile({ generateStatus: "failed", contentVersion: 2 })).toBe(true);
  expect(canRequestTeachingCompile({ generateStatus: "stale", contentVersion: 1 })).toBe(true);
  expect(canRequestTeachingCompile({ generateStatus: "queued", contentVersion: 0 })).toBe(false);
  expect(canRequestTeachingCompile({ generateStatus: "generating", contentVersion: 0 })).toBe(false);
  expect(canRequestTeachingCompile({ generateStatus: "ready", contentVersion: 1 })).toBe(false);
  expect(canRequestTeachingCompile({ generateStatus: "needs_check", contentVersion: 1 })).toBe(false);
});

it("labels generateStatus honestly and does not claim fake ready teaching content", () => {
  expect(teachingActivityGenerateStatusLabel("queued")).toBe("生成排队中");
  expect(teachingActivityGenerateStatusLabel("ready", { contentVersion: 0 })).toBe("主讲内容未生成");
  expect(teachingActivityGenerateStatusLabel("ready", { contentVersion: 1 })).toBe("主讲内容已就绪");
  expect(teachingActivityContentHonesty("ready")).toContain("不会伪造讲义");
  expect(teachingActivityContentHonesty("queued")).toContain("不会假装");
});

it("refuses compile when compilerEnabled is false", () => {
  expect(
    canRequestTeachingCompile({ generateStatus: "ready", contentVersion: 0 }, { compilerEnabled: false }),
  ).toBe(false);
});

it("uses courseTitle in topic summary instead of bare 今日主题学习", () => {
  const input = buildStartLearningCreateInput({
    localDate: "2026-10-14",
    courseTitle: "高等数学",
    courseId: "44444444-4444-4444-8444-444444444444",
  });
  expect(input.intentSummary).toContain("高等数学");
  expect(input.intentSummary).not.toBe("今日主题学习");
  expect(input.intentSummary.includes("今日主题学习")).toBe(false);
  expect(input.courseId).toBe("44444444-4444-4444-8444-444444444444");
  expect(input.clientKey).toBe("today-topic:2026-10-14");
  // Ending a session must not block starting another one the same day (R1).
  expect(input.continueAfterCompleted).toBe(true);
});

it("writes deduped sorted sourceIds capped at 32 on topic create", () => {
  const ids = Array.from({ length: 34 }, (_, i) => {
    const n = (i + 1).toString(16).padStart(12, "0");
    return `aaaaaaaa-aaaa-4aaa-8aaa-${n}`;
  });
  // duplicate first
  const input = buildStartLearningCreateInput({
    localDate: "2026-10-14",
    courseTitle: "高等数学",
    sourceIds: [ids[1]!, ids[0]!, ids[1]!, ...ids.slice(2)],
  });
  expect(input.sourceIds).toHaveLength(32);
  expect(input.sourceIds).toEqual([...new Set([ids[1]!, ids[0]!, ...ids.slice(2)])].sort().slice(0, 32));
  expect(input.createIntent).not.toHaveProperty("sourceIds");
});

it("materials gate is unavailable when activity requests one missing source", () => {
  const sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const input = buildStartLearningCreateInput({
    localDate: "2026-10-14",
    courseTitle: "高等数学",
    sourceIds: [sourceId],
  });
  expect(input.sourceIds).toEqual([sourceId]);
  const gate = probeMaterialsAvailability(input.sourceIds ?? [], []);
  expect(gate.materials).toBe("unavailable");
  expect(gate.materials).not.toBe("available");
  expect(gate.unavailableSourceIds).toEqual([sourceId]);
});

it("excludes card sessions, legacy activities, empty course_continue shells, sessionless span shells, and unavailable retests from pickCurrentTeachingActivity", () => {
  const usable = { ...base, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", updatedAt: "2026-10-11T01:00:00.000Z" };
  const newer = "2026-10-11T05:00:00.000Z";
  const cardByKey = { ...base, id: "11111111-1111-4111-8111-111111111112", clientKey: "card-session:abc", intentKind: "course_continue" as const, intentSummary: "有界卡片复习", updatedAt: newer };
  const cardByCheckpoint = { ...base, id: "11111111-1111-4111-8111-111111111113", checkpointJson: { cardReviewSession: { elapsedSeconds: 0 } }, updatedAt: newer };
  const legacy = { ...base, id: "11111111-1111-4111-8111-111111111114", clientKey: "legacy-course-continue:c1", courseId: "44444444-4444-4444-8444-444444444444", intentKind: "course_continue" as const, contentVersion: 1, updatedAt: newer };
  const emptyContinue = { ...base, id: "11111111-1111-4111-8111-111111111115", courseId: "44444444-4444-4444-8444-444444444444", intentKind: "course_continue" as const, contentVersion: 0, updatedAt: newer };
  const deadRetest = { ...base, id: "11111111-1111-4111-8111-111111111116", courseId: "44444444-4444-4444-8444-444444444444", intentKind: "goal" as const, contentVersion: 0, staticLessonUnavailable: "retest_unavailable" as const, updatedAt: newer };
  const sessionlessSpan = { ...base, id: "11111111-1111-4111-8111-111111111117", courseId: "44444444-4444-4444-8444-444444444444", intentKind: "goal" as const, contentVersion: 0, checkpointJson: { spanLesson: { sessionId: "missing" } }, updatedAt: newer };
  expect(pickCurrentTeachingActivity([usable, cardByKey, cardByCheckpoint, legacy, emptyContinue, deadRetest, sessionlessSpan])?.id).toBe(usable.id);
  expect(pickCurrentTeachingActivity([cardByKey, cardByCheckpoint, legacy, emptyContinue, deadRetest, sessionlessSpan])).toBeNull();

  const validStaticLesson = {
    ...base,
    id: "11111111-1111-4111-8111-111111111118",
    courseId: "44444444-4444-4444-8444-444444444444",
    intentKind: "course_continue" as const,
    contentVersion: 0,
    staticLesson: { protocol: "span-lesson-v1" as const, sessionId: "99999999-9999-4999-8999-999999999999" },
    updatedAt: newer,
  };
  expect(pickCurrentTeachingActivity([usable, validStaticLesson])?.id).toBe(validStaticLesson.id);
});

describe("cross-surface multi-activity selection & shared placeholder helper", () => {
  const courseId = "44444444-4444-4444-8444-444444444444";

  it("preserves workspace-level card summary guard while keeping course-scoped activities usable", () => {
    expect(isTeachingActivityPlaceholder({ ...base, courseId: null, intentSummary: "有界卡片复习" })).toBe(true);
    expect(isTeachingActivityPlaceholder({ ...base, courseId, intentSummary: "有界卡片复习", contentVersion: 1 })).toBe(false);
    expect(isTeachingActivityPlaceholder({
      ...base,
      courseId: null,
      intentKind: "course_continue",
      contentVersion: 0,
      staticLesson: { protocol: "span-lesson-v1", sessionId: "99999999-9999-4999-8999-999999999999" },
    })).toBe(true);
    expect(isTeachingActivityPlaceholder({
      ...base,
      courseId,
      intentKind: "course_continue",
      contentVersion: 0,
      staticLesson: { protocol: "span-lesson-v1", sessionId: "99999999-9999-4999-8999-999999999999" },
    })).toBe(false);
  });

  it("aligns pickCurrentTeachingActivity and currentCourseActivity across fractional ISO timestamps", () => {
    const wholeSecond = {
      ...base,
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      courseId,
      status: "paused" as const,
      updatedAt: "2026-11-17T10:00:00Z",
    };
    const halfSecondLater = {
      ...base,
      id: "11111111-1111-4111-8111-111111111111",
      courseId,
      status: "active" as const,
      updatedAt: "2026-11-17T10:00:00.500Z",
    };
    const nineTenthsLater = {
      ...base,
      id: "22222222-2222-4222-8222-222222222222",
      courseId,
      status: "paused" as const,
      updatedAt: "2026-11-17T10:00:00.9Z",
    };

    const twoRows = [wholeSecond, halfSecondLater];
    expect(pickCurrentTeachingActivity(twoRows)?.id).toBe(halfSecondLater.id);
    expect(currentCourseActivity(twoRows, courseId)?.id).toBe(halfSecondLater.id);

    const threeRows = [wholeSecond, halfSecondLater, nineTenthsLater];
    expect(pickCurrentTeachingActivity(threeRows)?.id).toBe(nineTenthsLater.id);
    expect(currentCourseActivity(threeRows, courseId)?.id).toBe(nineTenthsLater.id);
  });

  it("aligns UUID tie-breaks, active/paused combinations, and mixed shells across Today and Course", () => {
    const lowUuid = {
      ...base,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      courseId,
      status: "active" as const,
      updatedAt: "2026-11-17T10:00:00Z",
    };
    const highUuidEquivalentFormat = {
      ...base,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      courseId,
      status: "paused" as const,
      updatedAt: "2026-11-17T10:00:00.000Z",
    };
    const shellsAndClosed: TeachingActivity[] = [
      { ...base, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", courseId, status: "completed", updatedAt: "2026-11-17T12:00:00.000Z" },
      { ...base, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", courseId, status: "skipped", updatedAt: "2026-11-17T12:00:00.000Z" },
      { ...base, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", courseId, clientKey: "card-session:1", updatedAt: "2026-11-17T12:00:00.000Z" },
      { ...base, id: "f1111111-1111-4111-8111-111111111111", courseId, checkpointJson: { cardReviewSession: { elapsedSeconds: 10 } }, updatedAt: "2026-11-17T12:00:00.000Z" },
      { ...base, id: "f2222222-2222-4222-8222-222222222222", courseId, clientKey: `legacy-course-continue:${courseId}`, contentVersion: 1, updatedAt: "2026-11-17T12:00:00.000Z" },
      { ...base, id: "f3333333-3333-4333-8333-333333333333", courseId, clientKey: "span-lesson:1", updatedAt: "2026-11-17T12:00:00.000Z" },
      { ...base, id: "f4444444-4444-4444-8444-444444444444", courseId, intentKind: "course_continue", contentVersion: 0, updatedAt: "2026-11-17T12:00:00.000Z" },
      { ...base, id: "f5555555-5555-4555-8555-555555555555", courseId, staticLessonUnavailable: "retest_unavailable", updatedAt: "2026-11-17T12:00:00.000Z" },
    ];
    const mixed = [...shellsAndClosed, lowUuid, highUuidEquivalentFormat];
    expect(pickCurrentTeachingActivity(mixed)?.id).toBe(highUuidEquivalentFormat.id);
    expect(currentCourseActivity(mixed, courseId)?.id).toBe(highUuidEquivalentFormat.id);
    expect(pickCurrentTeachingActivity(shellsAndClosed)).toBeNull();
    expect(currentCourseActivity(shellsAndClosed, courseId)).toBeNull();
  });
});

describe("course-less writing workspace Today resume integration", () => {
  const roots: ReturnType<typeof createRoot>[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  const workGroupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const docB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const block2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const writingActivity: TeachingActivity = {
    ...base,
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    courseId: null,
    intentSummary: "独立思辨短文",
    generateStatus: "ready",
    checkpointJson: {
      writingWorkspace: {
        protocol: "writing-workspace-v1",
        workGroupId,
        activeDocumentId: docB,
        activeVariantLabel: "B 稿",
        savedRevisionNumber: 2,
        focusBlockId: block2,
        updatedAt: "2026-11-18T10:00:00.000Z",
      },
    },
  };

  it("resolves writing target and CTA label only for writing activities", () => {
    const target = resolveWritingActivityTarget(writingActivity);
    expect(target).toEqual({
      activityId: writingActivity.id,
      workGroupId,
      documentId: docB,
      variantLabel: "B 稿",
      savedRevisionNumber: 2,
      focusBlockId: block2,
      href: `/opening/library/${docB}?block=${block2}&activity=${writingActivity.id}`,
    });
    expect(todayActivityCtaLabel(writingActivity)).toBe("继续写作：B 稿");

    expect(resolveWritingActivityTarget(base)).toBeNull();
    expect(todayActivityCtaLabel(base)).toBe("继续学习");
    expect(todayActivityCtaLabel(null)).toBe("开始学习");
  });

  it("renders course-less writing CTA in TodayResumeBody only when writing target exists", () => {
    const emptyNoWriting = renderToStaticMarkup(
      createElement(TodayResumeBody, {
        state: { kind: "empty", courses: { status: "ready", items: [] } },
      }),
    );
    expect(emptyNoWriting).toContain("添加第一门课");
    expect(emptyNoWriting).not.toContain("继续写作：");

    const withWriting = renderToStaticMarkup(
      createElement(TodayResumeBody, {
        state: { kind: "empty", courses: { status: "ready", items: [] } },
        activity: writingActivity,
      }),
    );
    expect(withWriting).toContain("继续写作：B 稿");
    expect(withWriting).toContain(`/opening/library/${docB}?block=${block2}&amp;activity=${writingActivity.id}`);
  });

  it("navigates TodayDashboard primary CTA to writingTarget.href even without courses", async () => {
    const assign = vi.fn();
    const originalLocation = window.location;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ count: 0 }, { status: 200 })));
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign },
    });

    try {
      const api = {
        listTeachingActivities: vi.fn(async () => [writingActivity]),
        getTeachingResume: vi.fn(),
        listTasks: vi.fn(async () => ({ tasks: [] })),
        getToday: vi.fn(async () => ({ date: "2026-11-18", acceptedVersion: null, blocks: [] })),
      } as unknown as OpeningApi;

      const host = document.createElement("div");
      host.className = "group/workspace";
      document.body.append(host);
      const root = createRoot(host);
      roots.push(root);

      await act(async () => {
        root.render(
          createElement(TodayDashboard, {
            state: { kind: "empty", courses: { status: "ready", items: [] } },
            api,
            teachingLoopTrialEnabled: true,
          }),
        );
      });

      const cta = host.querySelector<HTMLButtonElement>('[data-today-primary-cta="true"]');
      expect(cta?.textContent).toBe("继续写作：B 稿");
      await act(async () => {
        cta?.click();
      });
      expect(assign).toHaveBeenCalledWith(
        `/opening/library/${docB}?block=${block2}&activity=${writingActivity.id}`,
      );
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
