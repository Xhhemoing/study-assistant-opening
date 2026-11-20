import type IORedis from "ioredis";
import { expect, it, vi } from "vitest";
import { createTutorStreamReader, createTutorStreamWriter, createWorkerTutorStreamWriter, withTutorDeltaBatches } from "./tutor-stream";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("sm95 parses the cached attempt fence and rejects malformed identities before delivery", async () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const context = { privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null,
    attemptFence: { attemptId: id, itemVersionId: id, rootObservationId: id, headObservationId: id, answerRevision: 1 } };
  const hgetall = vi.fn().mockResolvedValueOnce({ context: JSON.stringify(context), text: "cached", sequence: "1" })
    .mockResolvedValueOnce({ context: JSON.stringify({ ...context, attemptFence: { ...context.attemptFence, answerRevision: 0 } }), text: "cached", sequence: "1" });
  const reader = createTutorStreamReader({ hgetall } as unknown as IORedis);
  expect(await reader.read(id, id)).toMatchObject({ ...context, text: "cached", sequence: 1 });
  await expect(reader.read(id, id)).rejects.toThrow();
});

it("returns only confirmed publication sequences and includes the expected execution identity", async () => {
  const evalScript = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  const writer = createTutorStreamWriter({ eval: evalScript } as unknown as IORedis);
  expect(await writer.append("workspace", "job", "hello", "execution", 2)).toBe(1);
  expect(await writer.append("workspace", "job", "stale", "old-execution", 1)).toBe(0);
  expect(evalScript.mock.calls[0]?.slice(-2)).toEqual(["execution", 2]);
  expect(await writer.append("workspace", "job", "", "execution", 2)).toBe(0);
  expect(evalScript).toHaveBeenCalledTimes(2);
});

it("flushes at the monotonic deadline even when the timer callback has not run", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const published: string[] = [];
    await withTutorDeltaBatches(async (_signal, delta) => {
      await delta("first");
      await delta(" second");
      expect(published).toEqual(["first"]);
      now.mockReturnValue(41);
      await delta(" third");
      expect(published).toEqual(["first", " second"]);
    }, async text => { published.push(text); });
    expect(published).toEqual(["first", " second", " third"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    now.mockRestore();
    vi.useRealTimers();
  }
});

it.each(["Done.", "Done!", "Done?", "好。", "好！", "什么？", "Line\nNext"])("publishes %j before the provider finishes", async delta => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const published: string[] = [];
    await withTutorDeltaBatches(async (_signal, emit) => {
      await emit("First");
      await emit(" Next: ");
      expect(published).toEqual(["First"]);
      await emit(delta);
      expect(published).toEqual(["First", " Next: " + delta]);
    }, async text => { published.push(text); });
  } finally {
    vi.useRealTimers();
  }
});

it("confirms an unknown append on a replacement control connection after an outage", async () => {
  const transportError = new Error("Command timed out");
  const connectionClosed = new Error("Connection is closed.");
  const endedControl = {
    status: "ready", options: { retryStrategy: () => null }, disconnect: vi.fn(),
    eval: vi.fn<() => Promise<void>>().mockRejectedValue(connectionClosed),
    duplicate: vi.fn(),
  };
  const appendConnection = {
    status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    eval: vi.fn(async () => { endedControl.status = "end"; throw transportError; }),
  };
  const unreachable = {
    status: "end", on: vi.fn(), disconnect: vi.fn(), connect: vi.fn().mockRejectedValue(connectionClosed),
  };
  const replacement = {
    status: "ready", on: vi.fn(), disconnect: vi.fn(),
    eval: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined),
  };
  endedControl.duplicate.mockReturnValueOnce(appendConnection).mockReturnValueOnce(unreachable).mockReturnValue(replacement);
  const writer = createWorkerTutorStreamWriter(endedControl as unknown as IORedis, vi.fn());
  let failure: unknown;
  const result = writer.append("workspace", "job", "tail", "execution", 0).catch(error => { failure = error; });
  try {
    await vi.waitFor(() => expect(unreachable.disconnect).toHaveBeenCalled());
    expect(failure).toBeUndefined();
    await vi.waitFor(() => expect(failure).toBe(transportError), { timeout: 1500 });
    expect(replacement.eval).toHaveBeenCalledTimes(1);
  } finally {
    endedControl.eval.mockResolvedValue(undefined); // Let a failing candidate finish cleanup.
    await result;
    writer.disconnect();
  }
  expect(replacement.disconnect).toHaveBeenCalledOnce();
});

it("drains overlapping callbacks accepted before close in arrival order", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const finishProvider = deferred();
  const published: string[] = [];
  let emit!: (text: string) => Promise<void>;
  const run = withTutorDeltaBatches(async (_signal, delta) => {
    emit = delta;
    await finishProvider.promise;
  }, async text => {
    if (text === "first") {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    published.push(text);
  });
  const first = emit("first");
  await firstStarted.promise;
  const second = emit(" second");
  const third = emit(" third");
  finishProvider.resolve();
  await new Promise<void>(resolve => { setImmediate(resolve); });
  await emit(" late");
  releaseFirst.resolve();
  await Promise.all([first, second, third, run]);
  expect(published.join("")).toBe("first second third");
});
