import { expect, it } from "vitest";
import type { TeachingActivity } from "@aistudy/contracts";
import {
  buildStartLearningCreateInput,
  canRequestTeachingCompile,
  pickCurrentTeachingActivity,
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
  expect(teachingActivityContentHonesty("ready")).toContain("不会伪造讲义");
  expect(teachingActivityContentHonesty("queued")).toContain("不会假装");
});
