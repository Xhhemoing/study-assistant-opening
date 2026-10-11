import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayResumeBody } from "./today-resume-view";
import { TeachingActivityEmpty, TeachingActivityPanel } from "../teaching/activity-panel";
import type { TeachingActivity } from "@aistudy/contracts";
import { pickCurrentTeachingActivity, todayActivityCtaLabel } from "../teaching/today-activity";

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
    expect(html).toContain("不会伪造讲义");
    expect(html).toContain("打开自由对话（次要）");
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
