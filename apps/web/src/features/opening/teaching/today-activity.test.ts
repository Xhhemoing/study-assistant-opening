import { expect, it } from "vitest";
import type { TeachingActivity } from "@aistudy/contracts";
import { probeMaterialsAvailability } from "@aistudy/domain";
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
