import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InlineAttempt, defaultInlineSkillLabel } from "./inline-attempt";
import { createInlineAttemptSubmission } from "./inline-attempt-submission";
import { createInlineAttemptDrafts, inlineAttemptIdentityKey } from "./inline-attempt-drafts";

const id = "11111111-1111-4111-8111-111111111111";
const identity = { activityId: id, courseId: id, blockId: id, contentVersion: 3, sourceIds: [id], prompt: "求矩阵的秩", skillLabel: "矩阵秩", answer: "我的原答案" };

describe("inline teaching attempt", () => {
  it("isolates activity and content versions while retaining only the user's old draft", () => {
    const drafts = createInlineAttemptDrafts();
    const oldKey = inlineAttemptIdentityKey(id, id, 1);
    const nextKey = inlineAttemptIdentityKey(id, id, 2);
    drafts.set(oldKey, { answer: "尚未确认保存的答案", prompt: "旧版题干", skillLabel: "矩阵" });
    expect(nextKey).not.toBe(oldKey);
    expect(drafts.get(nextKey)).toBeUndefined();
    expect(drafts.previous(id, id, 2)).toEqual([[oldKey, { answer: "尚未确认保存的答案", prompt: "旧版题干", skillLabel: "矩阵" }]]);
    expect(drafts.previous("another-activity", id, 2)).toEqual([]);
    drafts.set(oldKey, null);
    expect(drafts.previous(id, id, 2)).toEqual([]);
  });
  it("renders an answer form without loading or exposing reference answers", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const html = renderToStaticMarkup(createElement(InlineAttempt, { blockId: id, prompt: identity.prompt, context: { id, courseId: id, sourceIds: [id], contentVersion: 3, intentSummary: "矩阵秩", status: "active", onCourseAssociated: vi.fn() } }));
    expect(html).toContain("我的原答案");
    expect(html).toContain("提交原答案，再看参考");
    expect(html).not.toContain("参考答案 · 请自行核对");
    expect(html).not.toContain("我答对了");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("captures activity and version, then saves the original answer as unverified", async () => {
    const client = { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockResolvedValue({ id }), submitAttempt: vi.fn().mockResolvedValue({ id, answer: identity.answer, outcome: "unverified" }) };
    const session = createInlineAttemptSubmission(identity, client);
    await session.submit();
    expect(client.createSession).toHaveBeenCalledWith({ activityId: id, courseId: id, skillLabel: "矩阵秩", sourceIds: [id] });
    expect(client.createAttempt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, teachingBlock: { blockId: id, contentVersion: 3 } }));
    expect(client.submitAttempt).toHaveBeenCalledWith(id, expect.objectContaining({ answer: identity.answer, outcome: "unverified", assistance: "independent", verdictSource: "self_report" }));
    await session.submit();
    expect(client.submitAttempt).toHaveBeenCalledTimes(1);
  });

  it("defaults the skill label from the prompt, not the activity intent title", () => {
    expect(defaultInlineSkillLabel("求矩阵的秩")).toBe("求矩阵的秩");
    expect(defaultInlineSkillLabel("  a\n\tb  ")).toBe("a b");
    const html = renderToStaticMarkup(createElement(InlineAttempt, {
      blockId: id,
      prompt: "求极限定义",
      context: { id, courseId: id, sourceIds: [id], contentVersion: 3, intentSummary: "今日主题学习", status: "active", onCourseAssociated: vi.fn() },
    }));
    expect(html).toContain("求极限定义");
    expect(html).not.toContain('value="今日主题学习"');
  });

  it("uses one in-flight submission and reuses its identity and client key after an unknown result", async () => {
    const client = { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockResolvedValue({ id }), submitAttempt: vi.fn().mockRejectedValueOnce(new Error("reply lost")).mockResolvedValue({ id }) };
    const session = createInlineAttemptSubmission(identity, client);
    const first = session.submit();
    expect(session.submit()).toBe(first);
    await expect(first).rejects.toThrow("reply lost");
    await session.submit();
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.createAttempt).toHaveBeenCalledTimes(1);
    expect(client.submitAttempt.mock.calls[0]).toEqual(client.submitAttempt.mock.calls[1]);
  });
});
