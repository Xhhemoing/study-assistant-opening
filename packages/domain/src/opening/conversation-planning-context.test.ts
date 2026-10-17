import { expect, it } from "vitest";
import type { ConversationPlanningContext } from "@aistudy/contracts";
import { conversationPlanningInstruction } from "./conversation-planning-context";
export const context: ConversationPlanningContext = {
  version: "conversation-planning-v1", asOf: "2026-10-16T16:00:00.000Z", date: "2026-10-16", timeZone: "America/Los_Angeles",
  settings: "configured", acceptedVersion: 2, courses: [{ alias: "c1", name: "矩阵" }],
  tasks: [{ alias: "t1", title: "练习", minutes: 20, courseAlias: "c1", deferred: false }],
  acceptedSlots: [{ taskAlias: "t1", start: "2026-10-16T16:00:00.000Z", end: "2026-10-16T16:20:00.000Z" }],
  hardSlots: [], learning: { status: "available", windowDays: 14, counts: { observations: 3, independentVerifiedCurrent: 1, unknownQualification: 2 } }, truncated: false,
};
it("uses workspace clocks and keeps aliases and qualified counts as read-only data", () => {
  const instruction = conversationPlanningInstruction(context);
  expect(instruction).toContain('"start":"09:00"'); expect(instruction).toContain('"unknownQualification":2');
  expect(instruction).toContain("别名不是真实ID"); expect(instruction).toContain("确认日历、不创建任务");
  expect(instruction).toContain("unknown不是错误");
});
it("keeps a full bounded projection within the instruction budget", () => {
  const instruction = conversationPlanningInstruction({ ...context,
    courses: Array.from({ length: 20 }, (_, index) => ({ alias: `c${index + 1}`, name: "课".repeat(60) })),
    tasks: Array.from({ length: 20 }, (_, index) => ({ alias: `t${index + 1}`, title: "任".repeat(60), minutes: 240, courseAlias: "c1", deferred: true })),
    acceptedSlots: Array.from({ length: 20 }, () => context.acceptedSlots[0]!),
    hardSlots: Array.from({ length: 20 }, () => ({ kind: "class", start: context.asOf, end: "2026-10-16T17:00:00.000Z" })),
    learning: { status: "limited", windowDays: 14, counts: null }, truncated: true,
  });
  expect(instruction.length).toBeLessThan(12_000); expect(instruction).toContain('"status":"limited"');
  expect(instruction).toContain('"counts":null');
});
