import { describe, expect, it } from "vitest";
import { assistantEntry, assistantRedirect } from "./assistant-entry";
import { studyContextReturnHref, studyConversationHref } from "./study-conversation-context";
const id = "11111111-1111-4111-8111-111111111111";

describe("global assistant entry", () => {
  it("preserves material version, selection and return address through the old route", () => {
    const query = { source: id, version: "0", page: "3", fragment: "α + β", returnTo: `/opening/library?source=${id}&version=0&page=3` };
    const redirect = assistantRedirect(query);
    expect(redirect).toMatch(/^\/opening\/today\?source=/);
    expect(new URL(redirect, "https://study.invalid").searchParams.get("ai")).toBe("1");
    const entry = assistantEntry(redirect);
    expect(entry.context).toMatchObject({ sourceId: id, sourceVersion: 0, page: 3, fragment: "α + β", returnTo: query.returnTo });
    expect(entry.fresh).toBe(true);
  });
  it("keeps invalid pinned identity blocked, never opens an unscoped fallback", () => {
    expect(assistantEntry(`/opening/assistant?version=2`).error).toContain("停止发送");
    expect(assistantEntry(`/opening/assistant?attemptId=bad`).error).toContain("停止发送");
  });
  it.each(["/opening/review?tab=cards", "/opening/cards?courseId=" + id])("round-trips a card question with its review return location %s", returnTo => {
    const context = {
      courseId: id,
      purpose: "card_answer" as const,
      label: "一元二次方程",
      fragment: "判别式有什么作用？\n参考内容：判断实根的个数。",
      returnTo,
    };
    const entry = assistantEntry(studyConversationHref(context));
    expect(entry.error).toBeUndefined();
    expect(entry.context).toEqual(context);
    expect(entry.fresh).toBe(true);
    expect(studyContextReturnHref(entry.context ?? undefined)).toBe(returnTo);
  });
  it("restores conversation identity and binds an unscoped open to the current course", () => {
    expect(assistantEntry("/opening/assistant?conversation=conversation-a").conversation).toBe("conversation-a");
    expect(assistantEntry("/opening/assistant", `/opening/courses/${id}/study`).context).toEqual({ courseId: id });
    expect(assistantEntry(`/opening/assistant?courseId=${id}&activityId=${id}`).key).not.toBe(assistantEntry(`/opening/assistant?courseId=${id}`).key);
  });
  it("lets a course-only study entry ask with course context and isolates language support", () => {
    const studyEntry = assistantEntry("/opening/assistant", `/opening/courses/${id}/study/span`);
    expect(studyEntry.error).toBeUndefined();
    expect(studyEntry.context).toEqual({ courseId: id });
    expect(assistantEntry(`/opening/assistant?attemptId=${id}&purpose=language_support`).key).not.toBe(assistantEntry(`/opening/assistant?attemptId=${id}&purpose=learning_help`).key);
  });
  it("starts an explicitly unbound conversation without restoring course history", () => {
    const entry = assistantEntry("/opening/assistant?context=none", `/opening/courses/${id}`);
    expect(entry.context).toBeUndefined();
    expect(entry.fresh).toBe(true);
    expect(entry.conversation).toBeNull();
    expect(assistantEntry("/opening/assistant?context=none", `/opening/courses/${id}/study`).error).toBeUndefined();
  });
});
