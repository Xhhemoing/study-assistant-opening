import { EventEmitter } from "node:events";
import type IORedis from "ioredis";
import { expect, it, vi } from "vitest";
import {
  createTutorStreamReader, createTutorStreamWriter, createWorkerTutorStreamWriter, isDefinitiveRedisRejection,
  isNonMutatingRedisReplyError, isTutorStreamExpiredError, isUnconfirmedStreamSealError, TutorStreamExpiredError,
  UnconfirmedStreamSealError, withTutorDeltaBatches,
} from "./tutor-stream";

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
    .mockResolvedValueOnce({ context: JSON.stringify({ ...context, attemptFence: { ...context.attemptFence, headRevision: 7 } }), text: "cached", sequence: "1" })
    .mockResolvedValueOnce({ context: JSON.stringify({ ...context, attemptFence: { ...context.attemptFence, answerRevision: 0 } }), text: "cached", sequence: "1" })
    .mockResolvedValueOnce({ context: JSON.stringify({ ...context, attemptFence: { ...context.attemptFence, headRevision: -1 } }), text: "cached", sequence: "1" });
  const reader = createTutorStreamReader({ hgetall } as unknown as IORedis);
  expect(await reader.read(id, id)).toMatchObject({ ...context, text: "cached", sequence: 1 });
  expect(await reader.read(id, id)).toMatchObject({ attemptFence: { ...context.attemptFence, headRevision: 7 }, text: "cached", sequence: 1 });
  await expect(reader.read(id, id)).rejects.toThrow();
  await expect(reader.read(id, id)).rejects.toThrow();
});

it("passes monotonic attempt-head revision key and headRevision argument in writer.begin", async () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const evalScript = vi.fn().mockResolvedValue(undefined);
  const writer = createTutorStreamWriter({ eval: evalScript } as unknown as IORedis);
  await writer.begin(id, id, {
    privacyEpoch: 1, contextSourceRefs: [], exposureReceiptId: null, executionId: id,
    attemptFence: { attemptId: id, itemVersionId: id, rootObservationId: id, headObservationId: id, answerRevision: 2, headRevision: 12 },
  });
  expect(evalScript).toHaveBeenCalledOnce();
  const [script, keyCount, _streamKey, _epochKey, headKey, revKey, _exec, _ctx, _ttl, _epoch, headId, headRev] = evalScript.mock.calls[0]!;
  expect(keyCount).toBe(4);
  expect(revKey).toBe(`${headKey}:rev`);
  expect(headId).toBe(id);
  expect(headRev).toBe("12");
  expect(script).toContain("attemptHeadRevision");
  expect(script).toContain("cachedRev > jobRev");
});

it("parses cached materialPurposePin and rejects malformed pins before delivery", async () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const materialPurposePin = { courseId: id, materialUse: "citation" as const, sources: [{
    sourceId: id, sourceVersion: 0, membershipId: id, purposeRevision: "2026-11-20T00:00:00.000000Z", purpose: "teaching" as const,
  }] };
  const context = { privacyEpoch: 0, contextSourceRefs: [{ sourceId: id, sourceVersion: 0 }], exposureReceiptId: null, materialPurposePin };
  const hgetall = vi.fn().mockResolvedValueOnce({ context: JSON.stringify(context), text: "cached", sequence: "1" })
    .mockResolvedValueOnce({ context: JSON.stringify({ ...context, materialPurposePin: { ...materialPurposePin, materialUse: "unknown" } }), text: "cached", sequence: "1" });
  const reader = createTutorStreamReader({ hgetall } as unknown as IORedis);
  expect(await reader.read(id, id)).toMatchObject({ ...context, text: "cached", sequence: 1 });
  await expect(reader.read(id, id)).rejects.toThrow();
});

it("parses temporaryMemoryExpiresAt and memoryOnly provenance refs and rejects invalid timestamps", async () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const expiresAt = "2026-11-21T01:00:00.000Z";
  const context = {
    privacyEpoch: 0,
    contextSourceRefs: [{ sourceId: id, sourceVersion: 0, memoryOnly: true }],
    exposureReceiptId: null,
    temporaryMemoryExpiresAt: expiresAt,
  };
  const hgetall = vi.fn()
    .mockResolvedValueOnce({ context: JSON.stringify(context), text: "cached", sequence: "1" })
    .mockResolvedValueOnce({ context: JSON.stringify({ ...context, temporaryMemoryExpiresAt: "not-a-date" }), text: "cached", sequence: "1" });
  const reader = createTutorStreamReader({ hgetall } as unknown as IORedis);
  expect(await reader.read(id, id)).toMatchObject({
    contextSourceRefs: [{ sourceId: id, sourceVersion: 0, memoryOnly: true }],
    temporaryMemoryExpiresAt: expiresAt,
    text: "cached",
    sequence: 1,
  });
  await expect(reader.read(id, id)).rejects.toThrow("invalid tutor stream cache");
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
  "NOAUTH Authentication required",
])("classifies definitive Redis rejections as non-retryable seal failures: %s", message => {
  const error = Object.assign(new Error(message), { name: "ReplyError" });
  expect(isDefinitiveRedisRejection(error)).toBe(true);
});

it.each(["LOADING Redis is loading the dataset in memory", "BUSY Redis is busy running a script",
  "CLUSTERDOWN Hash slot is not served", "MASTERDOWN Link with MASTER is down", "TRYAGAIN Multiple keys request during rehashing"])(
  "retries transient Redis reply %s while confirming a seal", async message => {
    vi.useFakeTimers();
    const appendError = new Error("Command timed out");
    const transientError = Object.assign(new Error(message), { name: "ReplyError" });
    const append = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
      eval: vi.fn().mockRejectedValue(appendError) };
    const transient = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
      eval: vi.fn().mockRejectedValue(transientError) };
    const confirmed = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
      eval: vi.fn().mockResolvedValue(undefined) };
    const producer = { duplicate: vi.fn().mockReturnValueOnce(append).mockReturnValueOnce(transient).mockReturnValueOnce(confirmed) };
    const writer = createWorkerTutorStreamWriter(producer as unknown as IORedis, vi.fn());
    try {
      const result = writer.append("workspace", "job", "tail", "execution", 0).then(
        () => undefined,
        error => error,
      );
      await vi.waitFor(() => expect(transient.eval).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(confirmed.eval).toHaveBeenCalledOnce());
      await expect(result).resolves.toBe(appendError);
    } finally {
      writer.disconnect();
      vi.useRealTimers();
    }
  },
);

it.each(["NOAUTH Authentication required", "NOPERM this user has no permissions", "WRONGPASS invalid password",
  "ERR command rejected", "READONLY replica is read only", "OOM command not allowed"])(
  "fails fast on definitive seal reply %s", async message => {
    const appendError = new Error("Command timed out");
    const sealError = Object.assign(new Error(message), { name: "ReplyError" });
    const append = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
      eval: vi.fn().mockRejectedValue(appendError) };
    const control = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
      eval: vi.fn().mockRejectedValue(sealError) };
    const producer = { duplicate: vi.fn().mockReturnValueOnce(append).mockReturnValueOnce(control) };
    const writer = createWorkerTutorStreamWriter(producer as unknown as IORedis, vi.fn());
    try {
      const error = await writer.append("workspace", "job", "tail", "execution", 0).catch(err => err);
      expect(error).toBe(sealError);
      expect(isUnconfirmedStreamSealError(error)).toBe(true);
      expect(producer.duplicate).toHaveBeenCalledTimes(2);
    } finally {
      writer.disconnect();
    }
  },
);

it.each(["WRONGPASS invalid username-password pair", "NOAUTH Authentication required"])(
  "preserves the emitted Redis rejection when connect closes: %s", async message => {
    const appendError = new Error("Command timed out");
    const reply = Object.assign(new Error(message), { name: "ReplyError" });
    const append = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
      eval: vi.fn().mockRejectedValue(appendError) };
    const control = Object.assign(new EventEmitter(), { status: "end", disconnect: vi.fn(), eval: vi.fn() });
    const connect = vi.fn(async () => {
      control.emit("error", reply);
      throw new Error("Connection is closed.");
    });
    const replacement = { ...append, eval: vi.fn().mockResolvedValue(undefined) };
    const producer = { duplicate: vi.fn().mockReturnValueOnce(append)
      .mockReturnValueOnce(Object.assign(control, { connect })).mockReturnValue(replacement) };
    const reportError = vi.fn();
    const writer = createWorkerTutorStreamWriter(producer as unknown as IORedis, reportError);
    try {
      await expect(writer.append("workspace", "job", "tail", "execution", 0)).rejects.toBe(reply);
      expect(reportError).toHaveBeenCalledWith(reply);
      expect(control.eval).not.toHaveBeenCalled();
      expect(control.disconnect).toHaveBeenCalledOnce();
      expect(producer.duplicate).toHaveBeenCalledTimes(2);
    } finally {
      writer.disconnect();
    }
  },
);

it("treats every Redis ReplyError as a non-mutating append rejection", () => {
  const error = Object.assign(new Error("LOADING Redis is loading the dataset in memory"), { name: "ReplyError" });
  expect(isNonMutatingRedisReplyError(error)).toBe(true);
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

it("bounds seal confirmation during a Redis outage and throws UnconfirmedStreamSealError", async () => {
  vi.useFakeTimers();
  const appendError = new Error("Command timed out");
  const connectError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const append = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    eval: vi.fn().mockRejectedValue(appendError) };
  const failingControl = () => ({ status: "end", on: vi.fn(), disconnect: vi.fn(), stream: { destroy: vi.fn() },
    connect: vi.fn().mockRejectedValue(connectError), eval: vi.fn() });
  const producer = { duplicate: vi.fn().mockReturnValueOnce(append).mockImplementation(failingControl) };
  const reportError = vi.fn();
  const writer = createWorkerTutorStreamWriter(producer as unknown as IORedis, reportError, {
    sealDeadlineMs: 1_200, sealRetryIntervalMs: 500,
  });
  try {
    const result = writer.append("workspace", "job", "tail", "execution", 0).then(
      () => undefined,
      error => error,
    );
    await vi.advanceTimersByTimeAsync(1_200);
    const error = await result;
    expect(error).toBeInstanceOf(UnconfirmedStreamSealError);
    expect(isUnconfirmedStreamSealError(error)).toBe(true);
    expect((error as UnconfirmedStreamSealError).cause).toBe(appendError);
    expect((error as UnconfirmedStreamSealError).sealError).toBe(connectError);
    expect(reportError).toHaveBeenCalledWith(connectError);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    writer.disconnect();
    vi.useRealTimers();
  }
});

it("aborts a hung seal attempt at sealDeadlineMs and destroys the stuck control socket", async () => {
  vi.useFakeTimers();
  const appendError = new Error("Command timed out");
  const append = { status: "ready", on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    eval: vi.fn().mockRejectedValue(appendError) };
  const hungControl = { status: "connecting", on: vi.fn(), disconnect: vi.fn(), stream: { destroy: vi.fn() },
    connect: vi.fn(() => new Promise<void>(() => undefined)), eval: vi.fn() };
  const producer = { duplicate: vi.fn().mockReturnValueOnce(append).mockReturnValueOnce(hungControl) };
  const reportError = vi.fn();
  const writer = createWorkerTutorStreamWriter(producer as unknown as IORedis, reportError, {
    sealDeadlineMs: 1_500,
  });
  try {
    const result = writer.append("workspace", "job", "tail", "execution", 0).then(
      () => undefined,
      error => error,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const error = await result;
    expect(error).toBeInstanceOf(UnconfirmedStreamSealError);
    expect(hungControl.disconnect).toHaveBeenCalledOnce();
    expect(hungControl.stream.destroy).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    writer.disconnect();
    vi.useRealTimers();
  }
});

it("enforces temporaryMemoryExpiresAt after Redis connect/reconnect and inside begin/append Lua scripts", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));
    const expiresAt = "2026-11-21T00:00:01.000Z";
    const id = "10000000-0000-4000-8000-000000000001";

    // 1. Direct writer checks Redis TIME + effectiveNowMs inside Lua and converts EXPIRED / -1 into TutorStreamExpiredError.
    const evalScript = vi.fn()
      .mockResolvedValueOnce("EXPIRED")
      .mockResolvedValueOnce(-1);
    const direct = createTutorStreamWriter({ eval: evalScript } as unknown as IORedis);
    await expect(direct.begin(id, id, {
      privacyEpoch: 0, contextSourceRefs: [], exposureReceiptId: null, executionId: id, temporaryMemoryExpiresAt: expiresAt,
    })).rejects.toBeInstanceOf(TutorStreamExpiredError);
    expect(evalScript.mock.calls[0]?.[0]).toContain("redis.call('TIME')");
    expect(evalScript.mock.calls[0]?.[0]).toContain("temporaryMemoryExpiresAt");

    await expect(direct.append(id, id, "delta", id, 0, undefined, expiresAt))
      .rejects.toBeInstanceOf(TutorStreamExpiredError);
    expect(evalScript.mock.calls[1]?.[0]).toContain("redis.call('TIME')");
    expect(evalScript.mock.calls[1]?.[0]).toContain("redis.call('HSET', KEYS[1], 'sealed', '1')");

    // 2. Worker writer re-checks Date.now() synchronously AFTER slow connect()/reconnect resolves, never issuing EVAL.
    const appendConn = {
      status: "ready",
      on: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(async () => {
        // Reconnect latency crosses temporaryMemoryExpiresAt before EVAL is dispatched.
        vi.advanceTimersByTime(2_000);
      }),
      eval: vi.fn(),
    };
    const producer = { duplicate: vi.fn().mockReturnValueOnce(appendConn) };
    const workerWriter = createWorkerTutorStreamWriter(producer as unknown as IORedis, vi.fn());
    try {
      const err = await workerWriter.append(id, id, "stale after reconnect", id, 0, undefined, expiresAt).catch(e => e);
      expect(err).toBeInstanceOf(TutorStreamExpiredError);
      expect(isTutorStreamExpiredError(err)).toBe(true);
      expect(appendConn.eval).not.toHaveBeenCalled();
      expect(producer.duplicate).toHaveBeenCalledOnce();
    } finally {
      workerWriter.disconnect();
    }
  } finally {
    vi.useRealTimers();
  }
});
