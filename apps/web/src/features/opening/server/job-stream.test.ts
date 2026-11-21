import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobStreamResponse } from "./job-stream";
import type { TutorStreamSnapshot } from "../../../../../worker/src/runtime/tutor-stream";

const job = { status: "running" as const, assistantTurnId: "assistant-1", conversationId: "conversation-1" };
const snapshot = (text: string, sequence: number): TutorStreamSnapshot => ({
  text, sequence, privacyEpoch: 3, contextSourceRefs: [], exposureReceiptId: "receipt-1", claimToken: "claim-1",
});
const decoder = new TextDecoder();
const readEvent = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const result = await reader.read();
  if (result.done) return null;
  const text = decoder.decode(result.value);
  const event = text.match(/event: (.+)\n/)?.[1];
  const data = JSON.parse(text.match(/data: (.+)\n/)![1]!);
  return { event, data };
};
function setup() {
  const abort = new AbortController();
  let cached: TutorStreamSnapshot | null = snapshot("最小提示", 1);
  let notify: () => void = () => undefined;
  let unavailable: () => void = () => undefined;
  const unsubscribe = vi.fn(async () => undefined);
  const close = vi.fn();
  const getJob = vi.fn(async () => job as typeof job | { status: "cancelled"; assistantTurnId: string; conversationId: string } | null);
  const authorizeSnapshot = vi.fn(async (_: TutorStreamSnapshot, commitAuthorized?: (authorizedJob: typeof job) => void) => {
    commitAuthorized?.(job);
    return job;
  });
  const read = vi.fn(async () => cached);
  const subscribe = vi.fn(async (onDelta: () => void, onUnavailable: () => void) => {
    notify = onDelta;
    unavailable = onUnavailable;
    return unsubscribe;
  });
  return { abort, unsubscribe, close, read, subscribe, getJob, authorizeSnapshot,
    change(text: string, sequence: number) { cached = snapshot(text, sequence); notify(); },
    missing() { cached = null; }, unavailable: () => unavailable(),
    open: () => createJobStreamResponse({ job, signal: abort.signal, reader: { read, subscribe }, getJob, authorizeSnapshot, close }),
  };
}
afterEach(() => { vi.useRealTimers(); });

describe("authorized tutor job event stream", () => {
  it("exposes only the observation execution id after authorizing streamed text", async () => {
    const deps = setup();
    const materialPurposePin = { courseId: "10000000-0000-4000-8000-000000000002", materialUse: "citation" as const, sources: [{
      sourceId: "10000000-0000-4000-8000-000000000003", sourceVersion: 0,
      membershipId: "10000000-0000-4000-8000-000000000004", purposeRevision: "2026-11-20T00:00:00.000000Z", purpose: "teaching" as const,
    }] };
    deps.read.mockResolvedValue({ ...snapshot("text", 1), executionId: "10000000-0000-4000-8000-000000000001", materialPurposePin });
    const reader = (await deps.open()).body!.getReader();
    const first = await readEvent(reader);
    expect(deps.authorizeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ materialPurposePin }), expect.any(Function), expect.any(Function));
    expect(first?.data.executionId).toBe("10000000-0000-4000-8000-000000000001");
    expect(first?.data).not.toHaveProperty("claimToken");
    expect(first?.data).not.toHaveProperty("materialPurposePin");
    await reader.cancel();
  });
  it("withholds cached text when course membership revocation rejects snapshot authorization", async () => {
    const deps = setup();
    const materialPurposePin = { courseId: "10000000-0000-4000-8000-000000000002", materialUse: "citation" as const, sources: [{
      sourceId: "10000000-0000-4000-8000-000000000003", sourceVersion: 0,
      membershipId: "10000000-0000-4000-8000-000000000004", purposeRevision: "2026-11-20T00:00:00.000000Z", purpose: "teaching" as const,
    }] };
    deps.read.mockResolvedValue({ ...snapshot("unauthorized course text", 1), materialPurposePin });
    deps.authorizeSnapshot.mockRejectedValueOnce(Object.assign(new Error("source purpose no longer permits this use"), { code: "CONFLICT" }));
    const response = await deps.open();
    expect(await response.text()).toBe("");
    expect(deps.authorizeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ materialPurposePin }), expect.any(Function), expect.any(Function));
    expect(deps.unsubscribe).toHaveBeenCalledOnce();
  });
  it("enqueues authorized bytes synchronously inside commitAuthorized before authorization commits", async () => {
    const deps = setup();
    const order: string[] = [];
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
    deps.authorizeSnapshot.mockImplementationOnce(async (_snap, commitAuthorized) => {
      order.push("tx-locked");
      commitAuthorized?.(job);
      order.push("enqueued-under-lock");
      await commitGate;
      order.push("tx-committed");
      return job;
    });
    const reader = (await deps.open()).body!.getReader();
    const first = await readEvent(reader);
    expect(first).toEqual({ event: "snapshot", data: {
      assistantTurnId: job.assistantTurnId, conversationId: job.conversationId, text: "最小提示", sequence: 1,
    } });
    // Bytes were delivered to the ReadableStream while authorizeSnapshot still held its lock.
    expect(order).toEqual(["tx-locked", "enqueued-under-lock"]);
    releaseCommit();
    await vi.waitFor(() => expect(order).toEqual(["tx-locked", "enqueued-under-lock", "tx-committed"]));
    // Subsequent delta after commit does not re-emit snapshot 1.
    deps.change("最小提示：继续", 2);
    expect(await readEvent(reader)).toEqual({ event: "delta", data: {
      assistantTurnId: job.assistantTurnId, conversationId: job.conversationId, text: "：继续", sequence: 2,
    } });
    await reader.cancel();
  });
  it("aborts commitAuthorized when the stream closed before delivery so the transaction rolls back", async () => {
    const deps = setup();
    let releaseRead!: () => void;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    let commitError: unknown;
    deps.authorizeSnapshot.mockImplementationOnce(async (_snap, commitAuthorized) => {
      await readGate;
      try { commitAuthorized?.(job); }
      catch (error) { commitError = error; throw error; }
      return job;
    });
    const response = await deps.open();
    const reader = response.body!.getReader();
    await vi.waitFor(() => expect(deps.authorizeSnapshot).toHaveBeenCalledOnce());
    deps.abort.abort();
    releaseRead();
    await vi.waitFor(() => expect(commitError).toBeInstanceOf(Error));
    expect(await readEvent(reader)).toBeNull();
  });
  it("withholds SSE enqueue inside commitAuthorized when snapshot temporaryMemoryExpiresAt has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
    const deps = setup();
    deps.read.mockResolvedValue({
      ...snapshot("expired temp memory text", 1),
      temporaryMemoryExpiresAt: "2026-11-21T00:00:01.000Z",
    });
    let commitError: unknown;
    deps.authorizeSnapshot.mockImplementationOnce(async (_snap, commitAuthorized) => {
      // Simulate clock advancing past temporaryMemoryExpiresAt while waiting for DB locks.
      vi.advanceTimersByTime(2_000);
      try { commitAuthorized?.(job); }
      catch (error) { commitError = error; throw error; }
      return job;
    });
    const response = await deps.open();
    expect(await response.text()).toBe("");
    expect(commitError).toBeInstanceOf(Error);
    expect((commitError as Error).message).toContain("temporary memory expired");
    expect(deps.unsubscribe).toHaveBeenCalledOnce();
  });
  it("subscribes first, releases help before the first bytes, and reconnects with a full snapshot", async () => {
    const deps = setup();
    let release: (() => void) | undefined;
    deps.authorizeSnapshot.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return job;
    });
    const response = await deps.open();
    const reader = response.body!.getReader();
    const first = readEvent(reader);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(deps.subscribe.mock.invocationCallOrder[0]).toBeLessThan(deps.read.mock.invocationCallOrder[0]!);
    let delivered = false;
    void first.then(() => { delivered = true; });
    await Promise.resolve();
    expect(delivered).toBe(false);
    release!();
    expect(await first).toEqual({ event: "snapshot", data: {
      assistantTurnId: job.assistantTurnId, conversationId: job.conversationId, text: "最小提示", sequence: 1,
    } });
    deps.change("最小提示：先消元", 2);
    expect(await readEvent(reader)).toEqual({ event: "delta", data: {
      assistantTurnId: job.assistantTurnId, conversationId: job.conversationId, text: "：先消元", sequence: 2,
    } });
    await reader.cancel();
    const reconnected = await deps.open();
    const next = reconnected.body!.getReader();
    expect((await readEvent(next))?.data).toMatchObject({ text: "最小提示：先消元", sequence: 2 });
    await next.cancel();
    expect(deps.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("coalesces real deltas into a snapshot when intermediate sequence numbers were missed", async () => {
    const deps = setup();
    const reader = (await deps.open()).body!.getReader();
    await readEvent(reader);
    deps.change("最小提示：先消元，再比较", 4);
    expect(await readEvent(reader)).toEqual({ event: "snapshot", data: {
      assistantTurnId: job.assistantTurnId, conversationId: job.conversationId,
      text: "最小提示：先消元，再比较", sequence: 4,
    } });
    await reader.cancel();
  });

  it("does not release help for an empty cache and closes when current permission rejects later text", async () => {
    const deps = setup();
    deps.missing();
    const reader = (await deps.open()).body!.getReader();
    expect((await readEvent(reader))?.data).toMatchObject({ text: "", sequence: 0 });
    expect(deps.authorizeSnapshot).not.toHaveBeenCalled();
    deps.authorizeSnapshot.mockRejectedValueOnce(new Error("source now excluded"));
    deps.change("不应被展示的文本", 1);
    expect(await readEvent(reader)).toBeNull();
    expect(deps.unsubscribe).toHaveBeenCalledOnce();
  });

  it("checks durable terminal state before emitting cached text and cleans up after request abort", async () => {
    const deps = setup();
    const reader = (await deps.open()).body!.getReader();
    await readEvent(reader);
    deps.abort.abort();
    expect(await readEvent(reader)).toBeNull();
    expect(deps.unsubscribe).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(deps.close).toHaveBeenCalledOnce());
    const terminal = await createJobStreamResponse({ job: { ...job, status: "succeeded" },
      signal: new AbortController().signal, reader: { read: deps.read, subscribe: deps.subscribe },
      getJob: deps.getJob, authorizeSnapshot: deps.authorizeSnapshot, close: deps.close });
    const terminalReader = terminal.body!.getReader();
    expect(await readEvent(terminalReader)).toEqual({ event: "terminal", data: { ...job, status: "succeeded" } });
    expect(await readEvent(terminalReader)).toBeNull();
    expect(deps.subscribe).toHaveBeenCalledOnce();
  });

  it("reports cancellation with no model text and disconnects failed Redis subscriptions", async () => {
    vi.useFakeTimers();
    const deps = setup();
    deps.missing();
    const reader = (await deps.open()).body!.getReader();
    await readEvent(reader);
    deps.getJob.mockResolvedValue({ ...job, status: "cancelled" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await readEvent(reader)).toEqual({ event: "terminal", data: { ...job, status: "cancelled" } });
    expect(await readEvent(reader)).toBeNull();

    const unavailable = setup();
    const unavailableReader = (await unavailable.open()).body!.getReader();
    await readEvent(unavailableReader);
    unavailable.unavailable();
    expect(await readEvent(unavailableReader)).toBeNull();
    expect(unavailable.unsubscribe).toHaveBeenCalledOnce();
  });

  it("returns service unavailable before opening a stream if subscribing fails", async () => {
    const deps = setup();
    deps.subscribe.mockRejectedValueOnce(new Error("private redis connection"));
    await expect(deps.open()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    expect(deps.close).toHaveBeenCalledOnce();
    expect(deps.read).not.toHaveBeenCalled();
  });
});
