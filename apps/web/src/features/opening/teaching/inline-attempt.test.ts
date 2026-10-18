import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlineAttempt } from "./inline-attempt";
import { createInlineAttemptSubmission } from "./inline-attempt-submission";
import { createInlineAttemptDrafts, inlineAttemptIdentityKey } from "./inline-attempt-drafts";
import { collectSkillLabelOptions, findSkillLabelReuseHint } from "../learning/skill-label-options";
import type { LearningAttempt } from "@aistudy/contracts";

const id = "11111111-1111-4111-8111-111111111111";
const identity = { activityId: id, courseId: id, blockId: id, contentVersion: 3, sourceIds: [id], prompt: "求矩阵的秩", skillLabel: "矩阵秩", answer: "我的原答案" };
const canonicalAttempt: LearningAttempt = { id, workspaceId: id, courseId: id, sessionId: id, skillLabel: identity.skillLabel,
  requirementKey: `teaching:${id}:v3`, sourceIds: [id], sourceVersions: { [id]: 1 }, problemId: null, itemVersionId: null,
  startedAt: "2026-10-18T00:00:00.000Z", submittedAt: null, observationId: null, historyRevision: 1 };
const savedObservation = { id, attemptId: id, courseId: id, sessionId: id, answer: identity.answer, outcome: "unverified" };

const summaryRows = [{ skillLabel: "矩阵秩" }, { skillLabel: "极限定义" }];
const getSummary = vi.fn().mockResolvedValue(summaryRows);

vi.mock("../client/learning-client", () => ({
  createOpeningLearningClient: () => ({
    getSummary: (...args: unknown[]) => getSummary(...args),
    listRevisionCourses: vi.fn().mockResolvedValue([]),
  }),
}));

describe("inline teaching attempt", () => {
  beforeEach(() => {
    getSummary.mockClear();
    getSummary.mockResolvedValue(summaryRows);
  });

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
    const onAttemptReady = vi.fn();
    const html = renderToStaticMarkup(createElement(InlineAttempt, { blockId: id, prompt: identity.prompt, context: { id, courseId: id, sourceIds: [id], contentVersion: 3, intentSummary: "矩阵秩", status: "active", onCourseAssociated: vi.fn(), onAttemptReady } }));
    expect(html).toContain("我的原答案");
    expect(html).toContain("提交原答案，再看参考");
    expect(html).not.toContain("参考答案 · 请自行核对");
    expect(html).not.toContain("我答对了");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onAttemptReady).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("captures activity and version, then saves the original answer as unverified", async () => {
    const client = { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockResolvedValue(canonicalAttempt), submitAttempt: vi.fn().mockResolvedValue(savedObservation) };
    const session = createInlineAttemptSubmission(identity, client);
    const result = await session.submit();
    expect(result.attempt).toBe(canonicalAttempt);
    expect(result.attempt.submittedAt).toBeNull(); // The submit receipt does not rewrite the canonical projection.
    expect(client.createSession).toHaveBeenCalledWith({ activityId: id, courseId: id, skillLabel: "矩阵秩", sourceIds: [id] });
    expect(client.createAttempt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, teachingBlock: { blockId: id, contentVersion: 3 } }));
    expect(client.submitAttempt).toHaveBeenCalledWith(id, expect.objectContaining({ answer: identity.answer, outcome: "unverified", assistance: "independent", verdictSource: "self_report" }));
    await session.submit();
    expect(client.submitAttempt).toHaveBeenCalledTimes(1);
  });

  it("keeps the skill label empty by default and uses the prompt only as placeholder", () => {
    const prompt = "求极限定义";
    const intentSummary = "今日主题学习";
    const html = renderToStaticMarkup(createElement(InlineAttempt, {
      blockId: id,
      prompt,
      context: { id, courseId: id, sourceIds: [id], contentVersion: 3, intentSummary, status: "active", onCourseAssociated: vi.fn() },
    }));
    expect(html).toContain(`placeholder="${prompt}"`);
    expect(html).toContain('value=""');
    expect(html).not.toContain(`value="${prompt}"`);
    expect(html).not.toContain(`value="${intentSummary}"`);
    expect(html).toContain("<datalist");
    // Options hydrate via client.getSummary → collectSkillLabelOptions (effects skip in static markup).
    expect(collectSkillLabelOptions(summaryRows)).toEqual(["极限定义", "矩阵秩"]);
  });

  it("hints near-duplicate skill reuse the same way as the learning attempt form", () => {
    expect(findSkillLabelReuseHint("矩阵 秩", ["矩阵秩"])).toBe("矩阵秩");
    expect(findSkillLabelReuseHint("矩阵秩", ["矩阵秩"])).toBeNull();
  });

  it("prefills the server-selected skill so the next answer stays in the same learning loop", () => {
    const html = renderToStaticMarkup(createElement(InlineAttempt, {
      blockId: id, prompt: identity.prompt,
      context: { id, courseId: id, sourceIds: [id], contentVersion: 3,
        intentSummary: "巩固练习", status: "active", onCourseAssociated: vi.fn(),
        learnerFocus: { skillLabel: "矩阵秩", activityKind: "targeted_explain", reasonCode: "verified_incorrect",
          focusObservationId: id, recentAssistance: ["independent"], strategyVersion: "adaptive-1" } },
    }));
    expect(html).toContain('value="矩阵秩"');
    expect(html).not.toContain('value="巩固练习"');
  });

  it("uses the current outline title when there is no selected learning skill", () => {
    const html = renderToStaticMarkup(createElement(InlineAttempt, {
      blockId: id, prompt: identity.prompt,
      context: { id, courseId: id, sourceIds: [id], contentVersion: 3,
        intentSummary: "今日主题学习", status: "active", onCourseAssociated: vi.fn(), outlineTitle: "矩阵秩" },
    }));
    expect(html).toContain('value="矩阵秩"');
  });

  it("uses one in-flight submission and reuses its identity and client key after an unknown result", async () => {
    const client = { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockResolvedValue(canonicalAttempt), submitAttempt: vi.fn().mockRejectedValueOnce(new Error("reply lost")).mockResolvedValue(savedObservation) };
    const session = createInlineAttemptSubmission(identity, client);
    const first = session.submit();
    expect(session.submit()).toBe(first);
    await expect(first).rejects.toThrow("reply lost");
    await session.submit();
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.createAttempt).toHaveBeenCalledTimes(1);
    expect(client.submitAttempt.mock.calls[0]).toEqual(client.submitAttempt.mock.calls[1]);
  });

  it.each([
    { courseId: "22222222-2222-4222-8222-222222222222" },
    { sessionId: "22222222-2222-4222-8222-222222222222" },
    { requirementKey: `teaching:${id}:v4` },
  ])("refuses a canonical attempt with mismatched context before submitting the answer", async mismatch => {
    const client = { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockResolvedValue({ ...canonicalAttempt, ...mismatch }), submitAttempt: vi.fn() };
    await expect(createInlineAttemptSubmission(identity, client).submit()).rejects.toThrow("不一致");
    expect(client.submitAttempt).not.toHaveBeenCalled();
  });

  it("does not unlock tutoring from a different attempt's save receipt", async () => {
    const client = { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockResolvedValue(canonicalAttempt),
      submitAttempt: vi.fn().mockResolvedValue({ ...savedObservation, attemptId: "22222222-2222-4222-8222-222222222222" }) };
    await expect(createInlineAttemptSubmission(identity, client).submit()).rejects.toThrow("保存回执");
  });
});
