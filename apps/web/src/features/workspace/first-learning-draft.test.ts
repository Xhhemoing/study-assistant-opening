import { describe, expect, it, vi } from "vitest";
import { emptyFirstLearningDraft, readFirstLearningDraft, saveFirstLearningDraft, submitFirstLearningDraft } from "./first-learning-draft";
const id = "11111111-1111-4111-8111-111111111111";
const draft = { clientKey: id, topic: "矩阵", goal: "理解线性变换", targetDate: "", minutes: 30, startTime: "19:00", timeZone: "Asia/Shanghai", sourceIds: [] };
describe("first-learning draft recovery", () => {
  it("restores a partial draft and the pending intent key after reload", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    saveFirstLearningDraft(storage, "owner/workspace", { ...draft, topic: "" });
    expect(readFirstLearningDraft(storage, "owner/workspace")).toEqual({ ...draft, topic: "" });
    expect(readFirstLearningDraft(storage, "other/workspace")).toBeNull();
  });
  it.each(["not json", '{"clientKey":"fake"}', JSON.stringify({ ...draft, sourceIds: ["not-an-id"] }), " ".repeat(17000)])("ignores invalid stored input", value => {
    expect(readFirstLearningDraft({ getItem: () => value }, "scope")).toBeNull();
  });
  it("does not make optional storage a prerequisite", () => {
    const storage = { getItem: () => { throw new Error("storage denied"); }, setItem: () => { throw new Error("storage denied"); } };
    expect(readFirstLearningDraft(storage, "scope")).toBeNull();
    expect(() => saveFirstLearningDraft(storage, "scope", draft)).not.toThrow();
    expect(emptyFirstLearningDraft(id, "Asia/Shanghai").topic).toBe("");
  });
  it("sends the same explicit intent once per retry, without scope fields or an invented deadline", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("network lost")).mockResolvedValueOnce(Response.json({ activityId: id, taskId: id, href: "/opening/today" }));
    await expect(submitFirstLearningDraft(draft, fetcher)).rejects.toThrow("未能确认");
    await expect(submitFirstLearningDraft(draft, fetcher)).resolves.toMatchObject({ href: "/opening/today" });
    const first = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(first).toEqual({ ...draft, targetDate: null });
    expect(fetcher.mock.calls[1]![1].body).toBe(fetcher.mock.calls[0]![1].body);
  });
  it("opens the exact created course activity directly", async () => {
    const href = `/opening/courses/${id}/study?activity=${id}`;
    await expect(submitFirstLearningDraft(draft, vi.fn().mockResolvedValue(Response.json({ activityId: id, taskId: id, courseId: id, href })))).resolves.toMatchObject({ href });
  });
  it.each(["https://example.com", "//example.com", `/opening/courses/${id}/study?activity=other`])("rejects an unrelated or external destination", async href => {
    await expect(submitFirstLearningDraft(draft, vi.fn().mockResolvedValue(Response.json({ activityId: id, taskId: id, courseId: id, href })))).rejects.toThrow();
  });
  it("treats a malformed successful response as uncertain, retaining the retry key", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    await expect(submitFirstLearningDraft(draft, fetcher)).rejects.toThrow("确认");
    expect(draft.clientKey).toBe(id);
  });
});

it("starts with a session duration and no recurring time or budget", () => {
  expect(emptyFirstLearningDraft(id, "Asia/Shanghai")).toMatchObject({ minutes: 20, startTime: "" });
  expect(emptyFirstLearningDraft(id, "Asia/Shanghai")).not.toHaveProperty("dailyMinutes");
});

it("submits an unscheduled intention and accepts the actual activity without inventing a task", async () => {
  const current = { ...emptyFirstLearningDraft(id, "Asia/Shanghai"), topic: "向量张成" };
  const href = `/opening/courses/${id}/study?activity=${id}`;
  const fetcher = vi.fn().mockResolvedValue(Response.json({ activityId: id, taskId: null, courseId: id, href }));
  await expect(submitFirstLearningDraft(current, fetcher)).resolves.toMatchObject({ taskId: null, href });
  const sent = JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(sent).toMatchObject({ minutes: 20, startTime: null });
  expect(sent).not.toHaveProperty("dailyMinutes");
});

it("recovers an explicit daily budget without turning session minutes into that budget", async () => {
  const current = { ...draft, startTime: "", dailyMinutes: 45 };
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  saveFirstLearningDraft(storage, "scope", current);
  expect(readFirstLearningDraft(storage, "scope")).toEqual(current);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ activityId: id, taskId: null, courseId: id, href: `/opening/courses/${id}/study?activity=${id}` }));
  await submitFirstLearningDraft(current, fetcher);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ minutes: 30, dailyMinutes: 45, startTime: null });
});
