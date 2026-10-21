import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayResumeBody } from "./today-resume-view";
import { TeachingActivityEmpty, TeachingActivityPanel } from "../teaching/activity-panel";
import type { ActivitySpecClientInit, TeachingActivity } from "@aistudy/contracts";
import { pickCurrentTeachingActivity, todayActivityCtaLabel } from "../teaching/today-activity";
import {
  isTeachingWorkspaceContentUsable,
  TeachingWorkspace,
} from "../teaching/teaching-workspace";
import { planTodayPrimaryCta } from "./today-dashboard";
import { isOpeningTeachingWorkspaceEnabled } from "../teaching/teaching-workspace-flag";
import { isOpeningTeachingLoopEnabled } from "../teaching/teaching-loop-flag";
import { isOpeningTeachingLoopTrialEnabled } from "../teaching/teaching-loop-trial";
import { TeachingLoopTrialEmpty } from "../teaching/teaching-loop-trial-empty";

const activity: TeachingActivity = {
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

describe("Today teaching-activity CTA semantics (CT-03)", () => {
  it("shows one first-course action only after a successful empty course read", () => {
    const empty = renderToStaticMarkup(createElement(TodayResumeBody, { state: { kind: "empty", courses: { status: "ready", items: [] } } }));
    expect(empty).toContain("添加第一门课");
    expect(empty.match(/<a\b/g)).toHaveLength(1);
    expect(empty).toContain('href="/opening/courses/new"');
    for (const state of [{ kind: "empty" as const }, { kind: "empty" as const, courses: { status: "error" as const } },
      { kind: "empty" as const, courses: { status: "ready" as const, items: [{ id: "course", title: "归档课程", archivedAt: "2026-10-01T00:00:00Z" }] } }]) {
      expect(renderToStaticMarkup(createElement(TodayResumeBody, { state }))).not.toContain("添加第一门课");
    }
  });
  it("asks for a learning intent before creating an empty first activity", () => {
    expect(planTodayPrimaryCta(null, null, false)).toEqual({ kind: "setup" });
    expect(planTodayPrimaryCta(activity, null, false)).toMatchObject({ kind: "focus-existing" });
  });
  it("uses 继续学习 when a resumable activity exists, else 开始学习", () => {
    expect(todayActivityCtaLabel(pickCurrentTeachingActivity([activity]))).toBe("继续学习");
    expect(todayActivityCtaLabel(null)).toBe("开始学习");
  });

  it("renders activity panel with honest generateStatus and demoted assistant link", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingActivityPanel, {
        activity,
        assistantHref: "/opening/assistant?conversation=11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(html).toContain("当前教学活动");
    expect(html).toContain("今日主题学习");
    expect(html).toContain("生成排队中");
    expect(html).toContain("不会假装");
    expect(html).toContain("打开自由对话（次要）");
    expect(html).toContain("/opening/assistant?conversation=");
  });

  it("empty main pane offers 开始学习 without embedding AssistantView", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingActivityEmpty, { onStart: () => undefined }),
    );
    expect(html).toContain("开始学习");
    expect(html).toContain("AI 主讲需要先配置模型并开启教学功能");
    expect(html).toContain("先聊一个问题");
    expect(html).not.toContain("AssistantView");
  });

  it("resume body shows 继续学习 when an activity is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(TodayResumeBody, {
        state: {
          kind: "ready",
          continueItem: {
            conversationId: "11111111-1111-4111-8111-111111111111",
            title: "线性代数答疑",
          },
        },
        activity,
      }),
    );
    expect(html).toContain("继续学习");
    expect(html).toContain("打开自由对话（次要）");
  });

  it("resume body demotes conversation continue to a secondary quiet link", () => {
    const html = renderToStaticMarkup(
      createElement(TodayResumeBody, {
        state: {
          kind: "ready",
          continueItem: {
            conversationId: "11111111-1111-4111-8111-111111111111",
            title: "线性代数答疑",
            lastUserText: "如何判断矩阵可逆？",
          },
        },
      }),
    );
    expect(html).toContain('data-today-primary-cta="true"');
    expect(html).toContain("开始学习");
    expect(html).toContain('href="/opening/today"');
    expect(html).toContain("打开自由对话（次要）");
    expect(html).toContain("/opening/assistant?conversation=11111111-1111-4111-8111-111111111111");
  });
});

describe("V2-10 teaching workspace gate (Today wire)", () => {
  const readyInit: ActivitySpecClientInit = {
    id: "88888888-8888-4888-8888-888888888888",
    activityId: activity.id,
    teachingUnitId: "77777777-7777-4777-8777-777777777777",
    documentId: "66666666-6666-4666-8666-666666666666",
    revisionNumber: 1,
    blockOrder: [
      {
        blockId: "44444444-4444-4444-8444-444444444444",
        position: 0,
        blockType: "text",
        role: "teach",
      },
    ],
    sourceRefs: [],
    goals: [],
    verificationStatus: "unchecked",
    generationConfig: {},
    version: 1,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
    blocks: [
      {
        blockId: "44444444-4444-4444-8444-444444444444",
        position: 0,
        blockType: "text",
        role: "teach",
        content: { text: "主讲正文" },
      },
    ],
    contentVersion: 1,
  };

  it("flag defaults off (C6)", () => {
    expect(isOpeningTeachingWorkspaceEnabled({})).toBe(false);
  });

  it("usable only when generateStatus ready + blocks present", () => {
    expect(
      isTeachingWorkspaceContentUsable(
        { ...activity, generateStatus: "ready" },
        readyInit,
      ),
    ).toBe(true);
    expect(isTeachingWorkspaceContentUsable(activity, readyInit)).toBe(false);
  });

  it("workspace does not add a competing primary CTA (C5)", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingWorkspace, {
        activity: { ...activity, generateStatus: "ready" },
        clientInit: readyInit,
      }),
    );
    expect(html).toContain("data-teaching-workspace=\"true\"");
    expect(html).not.toContain("data-today-primary-cta");
    expect(html).toContain("主讲正文");
    // Free exploration is now inside the on-demand settings panel. The initial
    // lesson keeps that panel closed and does not compete with Today's entry.
    expect(html).toMatch(/<button\b[^>]*aria-expanded="false"[^>]*>学习设置<\/button>/);
    expect(html).not.toMatch(/<a\b[^>]*href="\/opening\/assistant/);
  });
});

describe("V2-16 teaching loop UI trial dual-gate (Today wire)", () => {
  it("trial entry requires both loop and workspace flags", () => {
    expect(
      isOpeningTeachingLoopTrialEnabled({
        OPENING_TEACHING_LOOP: "1",
        OPENING_TEACHING_WORKSPACE: "1",
      }),
    ).toBe(true);
  });

  it("loop off → no trial entry (honest empty path)", () => {
    expect(
      isOpeningTeachingLoopTrialEnabled({
        OPENING_TEACHING_LOOP: "0",
        OPENING_TEACHING_WORKSPACE: "1",
      }),
    ).toBe(false);
    expect(isOpeningTeachingLoopEnabled({ OPENING_TEACHING_LOOP: "0" })).toBe(false);
    expect(isOpeningTeachingWorkspaceEnabled({ OPENING_TEACHING_WORKSPACE: "1" })).toBe(true);
  });

  it("workspace off → no trial entry (honest empty path)", () => {
    expect(
      isOpeningTeachingLoopTrialEnabled({
        OPENING_TEACHING_LOOP: "1",
        OPENING_TEACHING_WORKSPACE: "0",
      }),
    ).toBe(false);
  });

  it("both off → no trial entry (honest empty path)", () => {
    expect(isOpeningTeachingLoopTrialEnabled({})).toBe(false);
  });

  it("honest empty copy names both flags and demotes free chat", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingLoopTrialEmpty, {
        assistantHref: "/opening/assistant",
        loopEnabled: true,
        workspaceEnabled: false,
      }),
    );
    expect(html).toContain('data-teaching-loop-trial-empty="true"');
    expect(html).toContain("OPENING_TEACHING_LOOP");
    expect(html).toContain("OPENING_TEACHING_WORKSPACE");
    expect(html).toContain("不会进入主讲工作台");
    expect(html).toContain("打开自由对话（次要）");
    expect(html).not.toContain("data-teaching-workspace");
  });
});

describe("Today primary CTA visible continue (S7)", () => {
  const readyInit: ActivitySpecClientInit = {
    id: "88888888-8888-4888-8888-888888888888",
    activityId: activity.id,
    teachingUnitId: "77777777-7777-4777-8777-777777777777",
    documentId: "66666666-6666-4666-8666-666666666666",
    revisionNumber: 1,
    blockOrder: [
      {
        blockId: "44444444-4444-4444-8444-444444444444",
        position: 0,
        blockType: "text",
        role: "teach",
      },
    ],
    sourceRefs: [],
    goals: [],
    verificationStatus: "unchecked",
    generationConfig: {},
    version: 1,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
    blocks: [
      {
        blockId: "44444444-4444-4444-8444-444444444444",
        position: 0,
        blockType: "text",
        role: "teach",
        content: { text: "主讲正文" },
      },
    ],
    contentVersion: 1,
  };

  it("plans create when no activity exists", () => {
    expect(planTodayPrimaryCta(null, null)).toEqual({ kind: "create" });
  });

  it("plans focus-existing with preferWorkspace when content is usable (non-card phase)", () => {
    const ready = { ...activity, generateStatus: "ready" as const, contentVersion: 1 };
    const plan = planTodayPrimaryCta(ready, readyInit);
    expect(plan).toEqual({
      kind: "focus-existing",
      activityId: ready.id,
      preferWorkspace: true,
    });
  });

  it("plans focus-existing without preferWorkspace when content is not usable", () => {
    const plan = planTodayPrimaryCta(activity, null);
    expect(plan.kind).toBe("focus-existing");
    if (plan.kind === "focus-existing") {
      expect(plan.preferWorkspace).toBe(false);
      expect(plan.activityId).toBe(activity.id);
    }
  });
});
