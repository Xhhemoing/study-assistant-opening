import { expect, it, vi } from "vitest";
import type { SpanHintResponse } from "@aistudy/contracts";
import { nextSpanHintLevel, requestSpanHint } from "./span-hint-client";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const attempt = { id, itemVersionId: id, courseId: id };
function hint(): SpanHintResponse {
  return { attemptId: id, level: 1, text: "实际交付内容", exposureReceipt: { id, releaseKey: `span-hint-v1:${id}:1`,
    contextAnchor: { attemptId: id, itemVersionId: id, courseId: id, purpose: "learning_help" }, origin: "assistant", supportDomain: "math",
    generatedAt: "2026-10-21T00:00:00Z", releasedAt: "2026-10-21T00:00:00Z", acknowledgedAt: null, historyRevision: 1 } };
}
it("requests the selected level and returns only accepted content with its release receipt", async () => {
  const body = hint(), fetcher = vi.fn().mockResolvedValue(Response.json(body));
  expect(await requestSpanHint(attempt, 1, fetcher)).toEqual(body);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/opening/teaching/span/hint", expect.objectContaining({ body: JSON.stringify({ attemptId: id, level: 1 }) }));
});
it.each(["attempt", "level", "receiptAttempt", "itemVersion", "course", "release", "domain"])("rejects a response with a mismatched %s instead of advancing", async kind => {
  const body = hint();
  if (kind === "attempt") body.attemptId = other;
  if (kind === "level") body.level = 2;
  if (kind === "receiptAttempt") body.exposureReceipt.contextAnchor.attemptId = other;
  if (kind === "itemVersion") body.exposureReceipt.contextAnchor.itemVersionId = other;
  if (kind === "course") body.exposureReceipt.contextAnchor.courseId = other;
  if (kind === "release") body.exposureReceipt.releasedAt = null;
  if (kind === "domain") body.exposureReceipt.supportDomain = "language";
  await expect(requestSpanHint(attempt, 1, vi.fn().mockResolvedValue(Response.json(body)))).rejects.toThrow("对不上");
});
it("keeps retries at the same level after a failed delivery", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(Response.json(hint()));
  const delivered: SpanHintResponse[] = [];
  await expect(requestSpanHint(attempt, nextSpanHintLevel(delivered)!, fetcher)).rejects.toThrow("答案还在");
  expect(nextSpanHintLevel(delivered)).toBe(1);
  delivered.push(await requestSpanHint(attempt, nextSpanHintLevel(delivered)!, fetcher));
  expect(nextSpanHintLevel(delivered)).toBe(2);
  expect(nextSpanHintLevel([{ level: 1 }, { level: 2 }, { level: 3 }, { level: 4 }])).toBeNull();
});
it("does not display hint content without a readable release receipt", async () => {
  await expect(requestSpanHint(attempt, 1, vi.fn().mockResolvedValue(Response.json({ attemptId: id, level: 1, text: "unverified content" })))).rejects.toThrow("暂时没加载好");
});
it("accepts the existing full-solution receipt with its original unknown domain", async () => {
  const body = hint(); body.level = 4;
  body.exposureReceipt = { ...body.exposureReceipt, releaseKey: `span-feedback:${id}`, supportDomain: "unknown", origin: "history_solution", contextAnchor: { ...body.exposureReceipt.contextAnchor, purpose: "history_solution" } };
  expect(await requestSpanHint(attempt, 4, vi.fn().mockResolvedValue(Response.json(body)))).toEqual(body);
  body.exposureReceipt.supportDomain = "language";
  await expect(requestSpanHint(attempt, 4, vi.fn().mockResolvedValue(Response.json(body)))).rejects.toThrow("对不上");
});
it("does not reinterpret an unknown hint or an assistant release as a full solution", async () => {
  const body = hint(); body.exposureReceipt.supportDomain = "unknown";
  await expect(requestSpanHint(attempt, 1, vi.fn().mockResolvedValue(Response.json(body)))).rejects.toThrow("对不上");
  body.level = 4;
  await expect(requestSpanHint(attempt, 4, vi.fn().mockResolvedValue(Response.json(body)))).rejects.toThrow("对不上");
});
