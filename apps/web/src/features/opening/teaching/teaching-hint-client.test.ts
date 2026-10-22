import { expect, it, vi } from "vitest";
import { readReleasedTeachingHints, requestTeachingHint } from "./teaching-hint-client";
const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const attempt = { id, courseId: id, itemVersionId: null };
const context = { activityId: id, blockId: id, contentVersion: 3 };
function response(level: 1 | 4 = 1) { return { attemptId: id, level, text: "服务端持久提示", referenceSourceId: level === 4 ? id : null,
  exposureReceipt: { id, releaseKey: `teaching-hint-v1:${id}:${level}`, contextAnchor: { ...context, courseId: id, attemptId: id, itemVersionId: null, purpose: level === 4 ? "history_solution" : "learning_help" },
    origin: level === 4 ? "history_solution" : "assistant", supportDomain: "unknown", generatedAt: "2026-10-21T00:00:00Z", releasedAt: "2026-10-21T00:00:00Z", acknowledgedAt: null, historyRevision: 1 } }; }
it.each([1, 4] as const)("accepts only the actual generic level %s and its unknown-domain durable release", async level => {
  const body = response(level), fetcher = vi.fn().mockResolvedValue(Response.json(body));
  expect(await requestTeachingHint(attempt, context, level, fetcher)).toEqual(body);
  expect(fetcher.mock.calls[0]![0]).toBe("/api/opening/teaching/hint");
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ attemptId: id, level });
});
it.each([{ attemptId: other }, { activityId: other }, { blockId: other }, { contentVersion: 4 }, { courseId: other }, { itemVersionId: other }, { purpose: "language_support" }])("rejects a release for a different question anchor", async patch => {
  const body = response(); body.exposureReceipt.contextAnchor = { ...body.exposureReceipt.contextAnchor, ...patch };
  await expect(requestTeachingHint(attempt, context, 1, vi.fn().mockResolvedValue(Response.json(body)))).rejects.toThrow();
});
it.each([{ supportDomain: "language" }, { origin: "history_solution" }, { releasedAt: null }])("does not display mismatched or unreleased help", async patch => {
  const body = response(); Object.assign(body.exposureReceipt, patch);
  await expect(requestTeachingHint(attempt, context, 1, vi.fn().mockResolvedValue(Response.json(body)))).rejects.toThrow();
});
it("preserves the old-content unavailable reason instead of inventing missing hint levels", async () => {
  await expect(requestTeachingHint(attempt, context, 1, vi.fn().mockResolvedValue(Response.json({ error: { message: "此版教学内容没有分级提示，仍可提交作答" } }, { status: 409 })))).rejects.toMatchObject({ status: 409, message: expect.stringContaining("仍可提交") });
});
it("restores only released hints with a GET and retains their original receipts", async () => {
  const hints = [response(4), response(1)], fetcher = vi.fn().mockResolvedValue(Response.json({ hints }));
  expect(await readReleasedTeachingHints(attempt, context, fetcher)).toEqual([hints[1], hints[0]]);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/opening/teaching/hint?attemptId=${id}`, { cache: "no-store" });
});
it.each([{ attemptId: other }, { courseId: other }, { itemVersionId: other }, { activityId: other }, { blockId: other }, { contentVersion: 4 }])("rejects restored hints for a different canonical identity", async patch => {
  const hint = response(); hint.exposureReceipt.contextAnchor = { ...hint.exposureReceipt.contextAnchor, ...patch };
  await expect(readReleasedTeachingHints(attempt, context, vi.fn().mockResolvedValue(Response.json({ hints: [hint] })))).rejects.toThrow();
});
it.each([{ origin: "history_solution" }, { releasedAt: null }, { releaseKey: `teaching-hint-v1:${other}:1` }])("rejects mismatched release provenance on recovery", async patch => {
  const hint = response(); Object.assign(hint.exposureReceipt, patch);
  await expect(readReleasedTeachingHints(attempt, context, vi.fn().mockResolvedValue(Response.json({ hints: [hint] })))).rejects.toThrow();
});
it("accepts no released help without fabricating a stage and refuses duplicate levels", async () => {
  expect(await readReleasedTeachingHints(attempt, context, vi.fn().mockResolvedValue(Response.json({ hints: [] })))).toEqual([]);
  await expect(readReleasedTeachingHints(attempt, context, vi.fn().mockResolvedValue(Response.json({ hints: [response(), response()] })))).rejects.toThrow();
});
