import { describe, expect, it } from "vitest";
import type { TeachingActivity } from "@aistudy/contracts";
import { startSuggestions } from "./start-suggestions";

describe("start suggestions from existing records", () => {
  it("does not fabricate suggestions without records or treat failed reads as due work", () => {
    expect(startSuggestions({ state: { kind: "empty", courses: { status: "error" } }, today: "2026-10-22", reviewCount: null })).toEqual([]);
  });
  it("offers at most a resume, real due count and nearest unarchived exam", () => {
    const suggestions = startSuggestions({ state: { kind: "ready", continueItem: { conversationId: "chat", title: "向量张成", currentPage: 3 }, courses: { status: "ready", items: [
      { id: "later", title: "微积分", archivedAt: null, targetDate: "2026-12-02" },
      { id: "archived", title: "旧考试", archivedAt: "2026-10-01", targetDate: "2026-10-23" },
      { id: "past", title: "过去考试", archivedAt: null, targetDate: "2026-10-01" },
      { id: "next", title: "线性代数", archivedAt: null, targetDate: "2026-11-02" },
    ] } }, reviewCount: 9, today: "2026-10-22" });
    expect(suggestions).toEqual([
      { id: "conversation:chat", label: "继续：向量张成", meta: "第 3 页", href: "/opening/assistant?conversation=chat" },
      { id: "review", label: "复习 9 项", href: "/opening/review" },
      { id: "exam:next", label: "线性代数 · 2026-11-02 考试", meta: "冲刺", href: "/opening/sprint?courseId=next" },
    ]);
  });
  it("points a saved activity to its explicit study route without creating another activity", () => {
    const activity = { id: "activity", courseId: "course", intentSummary: "向量张成", status: "active", updatedAt: "2026-10-22T00:00:00Z" } as TeachingActivity;
    expect(startSuggestions({ state: { kind: "ready", continueItem: { conversationId: "chat", title: "旧对话" } }, activities: [activity], today: "2026-10-22" }))
      .toEqual([{ id: "activity:activity", label: "继续：向量张成", href: "/opening/courses/course/study?activity=activity" }]);
  });
});
