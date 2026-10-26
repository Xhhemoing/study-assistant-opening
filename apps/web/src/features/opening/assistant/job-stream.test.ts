import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createJobStream } from "./job-stream";
import { createJobPoller } from "./job-poller";

const jobId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const assistantTurnId = "33333333-3333-4333-8333-333333333333";
const encoder = new TextEncoder();
function channel() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; }, cancel }), { headers: { "content-type": "text/event-stream" } });
  return { response, writer, cancel, event(event: string, payload: Record<string, unknown>) {
    writer.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ conversationId, assistantTurnId, ...payload })}\n\n`));
  } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(0);

it("treats invalid observation metadata as a legacy stream without dropping its answer text", async () => {
  const source = channel(), onReply = vi.fn();
  const stream = createJobStream({ jobId, conversationId, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(source.response), onReply });
  stream.start();
  source.event("snapshot", { sequence: 0, text: "首段", executionId: "invalid" });
  await flush();
  expect(onReply).toHaveBeenLastCalledWith({ jobId, conversationId, assistantTurnId, text: "首段" });
  source.event("delta", { sequence: 1, text: "继续", executionId: "invalid" });
  await flush();
  expect(onReply).toHaveBeenLastCalledWith({ jobId, conversationId, assistantTurnId, text: "首段继续" });
  stream.cancel();
});

it("replaces old execution text and sequence only after a new full snapshot", async () => {
  const source = channel(), onReply = vi.fn();
  const oldExecution = "44444444-4444-4444-8444-444444444444", newExecution = "55555555-5555-4555-8555-555555555555";
  const stream = createJobStream({ jobId, conversationId, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(source.response), onReply });
  stream.start();
  source.event("snapshot", { sequence: 10, text: "旧执行", executionId: oldExecution });
  await flush();
  source.event("snapshot", { sequence: 1, text: "新执行", executionId: newExecution });
  source.event("delta", { sequence: 2, text: "的新文本", executionId: newExecution });
  await flush();
  expect(onReply).toHaveBeenLastCalledWith({ jobId, conversationId, assistantTurnId, text: "新执行的新文本", executionId: newExecution });
  source.event("delta", { sequence: 3, text: "过期内容", executionId: oldExecution });
  await flush();
  expect(onReply).toHaveBeenLastCalledWith({ jobId, conversationId, assistantTurnId, text: "新执行的新文本", executionId: newExecution });
  stream.cancel();
});

it("renders provider deltas before completion, restores cache on reconnect, and does not duplicate replayed deltas", async () => {
  const first = channel(), second = channel();
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
  const onReply = vi.fn();
  const stream = createJobStream({ jobId, conversationId, fetchImpl, onReply });
  stream.start();
  first.event("snapshot", { sequence: 0, text: "" });
  first.event("delta", { sequence: 1, text: "先看 **矩阵**。" });
  await flush();
  expect(onReply).toHaveBeenLastCalledWith({ jobId, conversationId, assistantTurnId, text: "先看 **矩阵**。" });
  expect(first.cancel).not.toHaveBeenCalled();
  first.writer.close();
  await flush();
  await vi.advanceTimersByTimeAsync(1000);
  second.event("snapshot", { sequence: 3, text: "先看 **矩阵**。再看秩。" });
  second.event("delta", { sequence: 2, text: "不应重复" });
  second.event("delta", { sequence: 4, text: "独立尝试。" });
  await flush();
  expect(onReply).toHaveBeenLastCalledWith({ jobId, conversationId, assistantTurnId, text: "先看 **矩阵**。再看秩。独立尝试。" });
  second.event("terminal", { status: "succeeded" });
  await flush();
  expect(second.cancel).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("recovers sequence gaps from a full snapshot instead of showing incomplete text", async () => {
  const first = channel(), second = channel();
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
  const onReply = vi.fn();
  const stream = createJobStream({ jobId, conversationId, fetchImpl, onReply });
  stream.start();
  first.event("snapshot", { sequence: 1, text: "A" });
  first.event("delta", { sequence: 3, text: "C" });
  await flush();
  expect(onReply).toHaveBeenLastCalledWith(expect.objectContaining({ text: "A" }));
  await vi.advanceTimersByTimeAsync(2000);
  second.event("snapshot", { sequence: 3, text: "ABC" });
  await flush();
  expect(onReply).toHaveBeenLastCalledWith(expect.objectContaining({ text: "ABC" }));
  stream.cancel();
  expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
});

it("ignores other conversation/turn events and late responses after cancellation", async () => {
  const first = channel();
  const onReply = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(first.response);
  const stream = createJobStream({ jobId, conversationId, fetchImpl, onReply });
  stream.start();
  first.event("snapshot", { sequence: 0, text: "wrong", conversationId: "other" });
  first.event("snapshot", { sequence: 0, text: "A" });
  first.event("delta", { sequence: 1, text: "wrong", assistantTurnId: "other" });
  await flush();
  expect(onReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "A" }));
  stream.cancel();
  await flush();
  expect(first.cancel).toHaveBeenCalledOnce();
  expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("keeps polling for the canonical persisted result when SSE is unavailable", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
  const onReply = vi.fn();
  const stream = createJobStream({ jobId, conversationId, fetchImpl, onReply });
  const job = { id: jobId, status: "running" as const, error: null, updatedAt: "2026-10-21T10:00:00.000Z" };
  const getJob = vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce({ ...job, status: "succeeded" });
  const onStatus = vi.fn();
  const poller = createJobPoller({ getJob, onStatus });
  stream.start(); poller.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(onReply).not.toHaveBeenCalled();
  expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: "succeeded" }), expect.any(AbortSignal));
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(getJob).toHaveBeenCalledTimes(2);
  stream.cancel(); poller.cancel();
});

it("pauses hidden pages, restores the cached answer on return, and removes visibility listeners", async () => {
  let hidden = false;
  const listeners = new Set<() => void>();
  const visibility = {
    get hidden() { return hidden; },
    addEventListener: vi.fn((_type: string, listener: () => void) => { listeners.add(listener); }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => { listeners.delete(listener); }),
  };
  const first = channel(), second = channel();
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
  const onReply = vi.fn();
  const stream = createJobStream({ jobId, conversationId, fetchImpl, onReply, visibility });
  stream.start();
  first.event("snapshot", { sequence: 1, text: "已有内容" });
  await flush();
  hidden = true; for (const notify of listeners) notify();
  await vi.advanceTimersByTimeAsync(10000);
  expect(first.cancel).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledOnce();
  hidden = false; for (const notify of listeners) notify();
  await flush();
  second.event("snapshot", { sequence: 8, text: "已有内容，后台继续完成的部分" });
  await flush();
  expect(onReply).toHaveBeenLastCalledWith(expect.objectContaining({ text: "已有内容，后台继续完成的部分" }));
  stream.cancel();
  expect(listeners.size).toBe(0);
});
