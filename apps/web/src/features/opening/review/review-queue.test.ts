import type { TaskItem } from "@aistudy/contracts";
import { describe, expect, it } from "vitest";
import { groupReviewTasks, loadReviewSources } from "./review-queue";
import { legacyCardsHref, readReviewTab, reviewTabHref } from "./review-route";

const now = Date.parse("2026-10-21T12:00:00Z");
function task(id: string, patch: Partial<TaskItem> = {}): TaskItem {
  return { id, title: id, minutes: 10, dueAt: null, priority: 1, status: "pending", courseId: "course", ...patch };
}
function retest(id: string, patch: Partial<TaskItem> = {}): TaskItem {
  return task(id, { retest: { candidateId: `candidate-${id}`, activityId: `activity-${id}`, courseId: "course", skillLabel: "span", prompt: "write", recommendedAt: null }, ...patch });
}

describe("real review task aggregation", () => {
  it("separates accepted retests from reinforcement without treating ordinary tasks as wrong answers", () => {
    const result = groupReviewTasks([retest("r"), task("weak", { suggestionKind: "weak_skill", origin: "planner" }), task("normal"), task("new", { suggestionKind: "new_skill" }), retest("done", { status: "done" }), retest("skipped", { status: "skipped" })], now);
    expect(result.ready.map(item => [item.task.id, item.kind])).toEqual([["r", "retest"], ["weak", "reinforcement"]]);
    expect(result.ready[0]?.href).toBe("/opening/courses/course/study?task=r");
  });
  it("enforces both recommendation time and deferral, including equality at the boundary", () => {
    const future = "2026-10-22T00:00:00Z", later = "2026-10-23T00:00:00Z";
    const scheduled = retest("scheduled");
    scheduled.retest!.recommendedAt = future;
    const result = groupReviewTasks([scheduled, retest("deferred", { notBefore: later }), retest("ready", { notBefore: "2026-10-21T12:00:00Z" })], now);
    expect(result.ready.map(item => item.task.id)).toEqual(["ready"]);
    expect(result.upcoming.map(item => item.task.id)).toEqual(["scheduled", "deferred"]);
    scheduled.notBefore = later;
    expect(groupReviewTasks([scheduled], now).upcoming[0]?.availableAt).toBe(later);
  });
  it("keeps missing or inconsistent course associations visible but non-actionable", () => {
    const result = groupReviewTasks([retest("mismatch", { courseId: "other" }), task("missing", { courseId: undefined, suggestionKind: "weak_skill" })], now);
    expect(result.ready).toEqual([]);
    expect(result.unavailable.map(item => item.href)).toEqual([null, null]);
  });
  it("does not turn a failed source into an empty queue or hide the successful source", async () => {
    const result = await loadReviewSources({ listCards: async () => { throw new Error("cards offline"); }, listTasks: async () => ({ tasks: [retest("r")] }) });
    expect(result.cards).toEqual({ kind: "error", message: "cards offline" });
    expect(result.tasks).toEqual({ kind: "ready", value: [retest("r")] });
    const reverse = await loadReviewSources({ listCards: async () => [], listTasks: async () => { throw new Error("tasks offline"); } });
    expect(reverse.cards).toEqual({ kind: "ready", value: [] });
    expect(reverse.tasks.kind).toBe("error");
  });
});

describe("review navigation", () => {
  it("redirects old cards URLs without losing query values", () => {
    const href = legacyCardsHref({ tab: "old", courseId: "course", source: ["one", "two"], seekMs: "4500", absent: undefined });
    const parsed = new URL(href, "http://localhost");
    expect(parsed.pathname).toBe("/opening/review");
    expect(parsed.searchParams.get("tab")).toBe("cards");
    expect(parsed.searchParams.getAll("source")).toEqual(["one", "two"]);
    expect(parsed.searchParams.get("seekMs")).toBe("4500");
    expect(parsed.searchParams.has("absent")).toBe(false);
  });
  it("uses valid tabs and preserves context in links", () => {
    expect(readReviewTab("retests")).toBe("retests");
    expect(readReviewTab("unknown")).toBe("all");
    expect(readReviewTab(["cards", "retests"])).toBe("all");
    expect(reviewTabHref("cards", "?courseId=c")).toBe("/opening/review?courseId=c&tab=cards");
  });
});
