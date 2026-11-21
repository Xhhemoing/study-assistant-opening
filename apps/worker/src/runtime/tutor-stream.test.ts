import type IORedis from "ioredis";
import { expect, it, vi } from "vitest";
import { createTutorStreamReader, createTutorStreamWriter, createWorkerTutorStreamWriter, isDefinitiveRedisRejection, withTutorDeltaBatches } from "./tutor-stream";

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
  expect(evalScript.mock.calls[0]?.slice(-3)).toEqual(["execution", 2, ""]);
  expect(await writer.append("workspace", "job", "", "execution", 2)).toBe(0);
  expect(evalScript).toHaveBeenCalledTimes(2);
});

it.each([
  "ERR command rejected by Redis",
  "OOM command not allowed when used memory > 'maxmemory'",
  "READONLY You can't write against a read only replica.",
  "NOPERM this user has no permissions to run the 'eval' command",
  "WRONGPASS invalid username-password pair",
])("classifies definitive Redis rejections as non-retryable seal failures: %s", message => {
  const error = Object.assign(new Error(message), { name: "ReplyError" });
  expect(isDefinitiveRedisRejection(error)).toBe(true);
});

it("does not retry a Redis OOM seal while an append publication is held", async () => {
  const appendError = new Error("Command timed out");
  const sealError = Object.assign(new Error("OOM command not allowed when used memory > 'maxmemory'"), { name: "ReplyError" });
  const append = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    eval: vi.fn().mockRejectedValue(appendError) };
  const control = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    eval: vi.fn().mockRejectedValue(sealError) };
  const producer = { duplicate: vi.fn().mockReturnValueOnce(append).mockReturnValueOnce(control) };
  const writer = createWorkerTutorStreamWriter(producer as unknown as IORedis, vi.fn());

  await expect(writer.append("workspace", "job", "tail", "execution", 0)).rejects.toBe(sealError);
  expect(producer.duplicate).toHaveBeenCalledTimes(2);
  writer.disconnect();
});

it("propagates an append OOM without opening a seal retry loop", async () => {
  const appendError = Object.assign(new Error("OOM command not allowed when used memory > 'maxmemory'"), { name: "ReplyError" });
  const append = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    eval: vi.fn().mockRejectedValue(appendError) };
  const producer = { duplicate: vi.fn().mockReturnValueOnce(append) };
  const writer = createWorkerTutorStreamWriter(producer as unknown as IORedis, vi.fn());

  await expect(writer.append("workspace", "job", "tail", "execution", 0)).rejects.toBe(appendError);
  expect(producer.duplicate).toHaveBeenCalledOnce();
  writer.disconnect();
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
  const producer = { duplicate: vi.fn() };
  const appendConnection = {
    status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    eval: vi.fn().mockRejectedValue(transportError),
  };
  const unreachable = {
    status: "end", on: vi.fn(), disconnect: vi.fn(), connect: vi.fn().mockRejectedValue(connectionClosed),
  };
  const confirmation = deferred();
  const replacement = {
    status: "ready", on: vi.fn(), disconnect: vi.fn(),
    eval: vi.fn(() => confirmation.promise), connect: vi.fn().mockResolvedValue(undefined),
  };
  producer.duplicate.mockReturnValueOnce(appendConnection).mockReturnValueOnce(unreachable).mockReturnValue(replacement);
  const writer = createWorkerTutorStreamWriter(producer as unknown as IORedis, vi.fn());
  let failure: unknown;
  const result = writer.append("workspace", "job", "tail", "execution", 0).catch(error => { failure = error; });
  try {
    await vi.waitFor(() => expect(unreachable.disconnect).toHaveBeenCalled());
    expect(failure).toBeUndefined();
    expect(replacement.eval).toHaveBeenCalledTimes(1);
  } finally {
    confirmation.resolve();
    await result;
    writer.disconnect();
  }
  expect(failure).toBe(transportError);
  expect(replacement.disconnect).toHaveBeenCalledOnce();
});

it("retries a timed-out ready control on a fresh connection before releasing the append failure", async () => {
  const appendError = new Error("Append timed out");
  const sealError = new Error("Command timed out");
  const append = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(), eval: vi.fn().mockRejectedValue(appendError) };
  const stuckControl = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(), stream: { destroy: vi.fn() }, eval: vi.fn().mockRejectedValue(sealError) };
  const confirmation = deferred();
  const freshControl = { on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    eval: vi.fn(() => confirmation.promise) };
  const producer = { status: "ready", eval: vi.fn().mockResolvedValue(undefined), duplicate: vi.fn()
    .mockReturnValueOnce(append).mockReturnValueOnce(stuckControl).mockReturnValue(freshControl) };
  const writer = createWorkerTutorStreamWriter(producer as unknown as IORedis, vi.fn());
  let failure: unknown;
  const result = writer.append("workspace", "job", "tail", "execution", 0).catch(error => { failure = error; });
  try {
    // Let the failed seal and its immediate retry drain without advancing any timer.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(stuckControl.disconnect).toHaveBeenCalledOnce();
    expect(stuckControl.stream.destroy).toHaveBeenCalledOnce();
    expect(freshControl.eval).toHaveBeenCalledOnce();
    expect(failure).toBeUndefined();
  } finally {
    confirmation.resolve();
    await result;
    writer.disconnect();
  }
  expect(failure).toBe(appendError);
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
