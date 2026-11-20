import type IORedis from "ioredis";
import { setTimeout as delay } from "node:timers/promises";
import { parseContextSourceRefs, tutorAttemptFenceSchema, type TutorAttemptFence, type ContextSourceRef } from "@aistudy/database";
import { uuidSchema } from "@aistudy/contracts";

export type TutorStreamContext = {
  privacyEpoch: number;
  contextSourceRefs: ContextSourceRef[];
  exposureReceiptId: string | null;
  claimToken?: string;
  executionId?: string;
  attemptFence?: TutorAttemptFence;
};
export type TutorStreamDelta = { text: string; sequence: number };
export type TutorStreamSnapshot = TutorStreamContext & TutorStreamDelta;
const TTL_SECONDS = 15 * 60;
const keyFor = (workspaceId: string, jobId: string) => `opening:tutor-stream:${workspaceId}:${jobId}`;
const channelFor = (workspaceId: string, jobId: string) => `${keyFor(workspaceId, jobId)}:events`;

const DELTA_BATCH_MAX_BYTES = 256;
const DELTA_BATCH_MAX_MS = 40;

/** Scope the buffer and its timer to one provider execution. */
export async function withTutorDeltaBatches<T>(
  produce: (signal: AbortSignal, onTextDelta: (delta: string) => Promise<void>) => Promise<T>,
  authorizeAndPublish: (text: string) => Promise<void>,
): Promise<{ value: T; publicationFailure?: { reason: unknown } }> {
  const controller = new AbortController();
  const signal = controller.signal;
  let first = true;
  let closing = false;
  let buffer = "";
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let pending: Promise<void> | undefined;

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!buffer) return active;
    const text = buffer;
    buffer = "";
    // Keep the timer's promise handled and interrupt a provider stalled in read().
    active = Promise.resolve().then(() => authorizeAndPublish(text))
      .catch(error => controller.abort(error))
      .finally(() => { active = undefined; });
    return active;
  }

  async function accept(delta: string, receivedAt: number) {
    // Drain in order, including an expired batch whose timer has not run yet.
    while (active || (buffer && performance.now() >= deadline)) {
      await (active ?? flush());
    }
    signal.throwIfAborted();

    if (!buffer) deadline = receivedAt + DELTA_BATCH_MAX_MS;
    buffer += delta;
    if (first || Buffer.byteLength(buffer, "utf8") >= DELTA_BATCH_MAX_BYTES || performance.now() >= deadline) {
      first = false;
      await flush();
      signal.throwIfAborted();
    } else {
      timer ??= setTimeout(() => { void flush(); }, Math.max(0, deadline - performance.now()));
    }
  }

  function onTextDelta(delta: string): Promise<void> {
    if (!delta || closing) return Promise.resolve();
    const receivedAt = performance.now();
    const accepted = pending ? pending.then(() => accept(delta, receivedAt)) : accept(delta, receivedAt);
    // Track the accepted callback even if the provider does not await it.
    const drained = accepted.catch(error => controller.abort(error));
    pending = drained;
    void drained.then(() => { if (pending === drained) pending = undefined; });
    return accepted;
  }

  let value: T;
  let providerFinished = false;
  try {
    value = await produce(signal, onTextDelta);
    providerFinished = true;
  } finally {
    closing = true;
    await pending;
    await flush();
    if (!providerFinished) signal.throwIfAborted();
  }
  // A rejected tail can stop delivery after the provider has already returned usage.
  return signal.aborted ? { value, publicationFailure: { reason: signal.reason } } : { value };
}

/** Redis is temporary presentation state; completed answers and job status remain in PostgreSQL. */
export function createTutorStreamWriter(redis: IORedis) {
  return {
    async begin(workspaceId: string, jobId: string, context: TutorStreamContext) {
      await redis.eval(`
        if redis.call('HGET', KEYS[1], 'executionId') == ARGV[1]
          and redis.call('HGET', KEYS[1], 'sealed') == '1' then return end
        redis.call('DEL', KEYS[1])
        redis.call('HSET', KEYS[1], 'executionId', ARGV[1], 'context', ARGV[2], 'text', '', 'sequence', '0')
        redis.call('EXPIRE', KEYS[1], ARGV[3])
      `, 1, keyFor(workspaceId, jobId), context.executionId ?? "", JSON.stringify(context), TTL_SECONDS);
    },
    async seal(workspaceId: string, jobId: string, executionId: string) {
      await redis.eval(`
        local execution = redis.call('HGET', KEYS[1], 'executionId')
        if execution == ARGV[1] then
          redis.call('HSET', KEYS[1], 'sealed', '1')
        elseif not execution then
          -- Cancellation may arrive before the worker initializes its cache.
          redis.call('HSET', KEYS[1], 'executionId', ARGV[1], 'sealed', '1')
          redis.call('EXPIRE', KEYS[1], ARGV[2])
        end
      `, 1, keyFor(workspaceId, jobId), executionId, TTL_SECONDS);
    },
    async append(workspaceId: string, jobId: string, text: string, executionId?: string): Promise<number> {
      if (!text) return 0;
      // Append, sequence and notification are one atomic operation. A late subscriber reads the full snapshot.
      const result = await redis.eval(`
        if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
        if (redis.call('HGET', KEYS[1], 'executionId') or '') ~= ARGV[3] then return 0 end
        if redis.call('HGET', KEYS[1], 'sealed') == '1' then return 0 end
        local text = redis.call('HGET', KEYS[1], 'text') or ''
        local sequence = redis.call('HINCRBY', KEYS[1], 'sequence', 1)
        redis.call('HSET', KEYS[1], 'text', text .. ARGV[1])
        redis.call('EXPIRE', KEYS[1], ARGV[2])
        redis.call('PUBLISH', KEYS[2], cjson.encode({text=ARGV[1], sequence=sequence}))
        return sequence
      `, 2, keyFor(workspaceId, jobId), channelFor(workspaceId, jobId), text, TTL_SECONDS, executionId ?? "");
      if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new Error("invalid stream publication sequence");
      return result;
    },
  };
}
export type TutorStreamWriter = ReturnType<typeof createTutorStreamWriter>;

/** The worker holds PostgreSQL publication locks until this append settles. */
export function createWorkerTutorStreamWriter(producer: IORedis, reportError: (error: unknown) => void) {
  const control = createTutorStreamWriter(producer);
  let appendConnection: ReturnType<typeof openAppendConnection> | undefined;

  function openAppendConnection() {
    const redis = producer.duplicate({ lazyConnect: true, autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    redis.on("error", reportError);
    return { redis, writer: createTutorStreamWriter(redis), ready: redis.connect() };
  }

  function disconnect(connection = appendConnection) {
    if (!connection || connection !== appendConnection) return;
    appendConnection = undefined;
    connection.redis.disconnect();
    // ioredis disconnect starts a graceful socket close. Discard unsent data immediately.
    connection.redis.stream?.destroy();
  }

  async function sealUntilConfirmed(workspaceId: string, jobId: string, executionId: string) {
    let reported = false;
    for (;;) {
      try {
        await control.seal(workspaceId, jobId, executionId);
        return;
      } catch (error) {
        if (!reported) reportError(error);
        reported = true;
        await delay(500);
      }
    }
  }

  return {
    begin: control.begin,
    seal: control.seal,
    disconnect: () => disconnect(),
    async append(workspaceId: string, jobId: string, text: string, executionId?: string) {
      if (!text) return 0;
      if (appendConnection?.redis.status === "end") disconnect();
      const connection = appendConnection ??= openAppendConnection();
      try {
        await connection.ready;
        if (connection.redis.status !== "ready") throw new Error("tutor stream Redis is disconnected");
      } catch (error) {
        disconnect(connection);
        throw error;
      }
      try {
        return await connection.writer.append(workspaceId, jobId, text, executionId);
      } catch (error) {
        disconnect(connection);
        // Redis may still execute bytes already in transit. A confirmed seal on
        // the control connection orders that EVAL on Redis: it either already
        // ran under the PG locks, or sees the seal (or a missing/new execution).
        // An unavailable control connection must keep the PG locks held.
        await sealUntilConfirmed(workspaceId, jobId, executionId ?? "");
        throw error;
      }
    },
  };
}

function parseSnapshot(row: Record<string, string>): TutorStreamSnapshot | null {
  if (!row.context) return null;
  const context = JSON.parse(row.context) as TutorStreamContext;
  const refs = parseContextSourceRefs(context.contextSourceRefs);
  const sequence = Number(row.sequence);
  if (!refs || !Number.isSafeInteger(context.privacyEpoch) || context.privacyEpoch < 0
    || !Number.isSafeInteger(sequence) || sequence < 0 || typeof row.text !== "string"
    || !(context.exposureReceiptId === null || typeof context.exposureReceiptId === "string")
    || (context.claimToken !== undefined && typeof context.claimToken !== "string")
    || (context.executionId !== undefined && !uuidSchema.safeParse(context.executionId).success)) throw new Error("invalid tutor stream cache");
  const fence = context.attemptFence === undefined ? undefined : tutorAttemptFenceSchema.parse(context.attemptFence);
  return { ...context, ...(fence ? { attemptFence: fence } : {}), contextSourceRefs: refs, text: row.text, sequence };
}

export function createTutorStreamReader(redis: IORedis) {
  return {
    async read(workspaceId: string, jobId: string): Promise<TutorStreamSnapshot | null> {
      return parseSnapshot(await redis.hgetall(keyFor(workspaceId, jobId)));
    },
    async subscribe(workspaceId: string, jobId: string, onDelta: (delta: TutorStreamDelta) => void, onUnavailable?: () => void): Promise<() => Promise<void>> {
      const subscriber = redis.duplicate({ lazyConnect: true });
      const channel = channelFor(workspaceId, jobId);
      const listener = (received: string, raw: string) => {
        if (received !== channel) return;
        try {
          const delta = JSON.parse(raw) as TutorStreamDelta;
          if (typeof delta.text === "string" && Number.isSafeInteger(delta.sequence) && delta.sequence > 0) onDelta(delta);
        } catch { /* Invalid cache notification is ignored; the durable status poll remains available. */ }
      };
      subscriber.on("message", listener);
      // A Redis disconnect must not become an unhandled EventEmitter error.
      subscriber.on("error", () => onUnavailable?.());
      subscriber.on("end", () => onUnavailable?.());
      try { await subscriber.connect(); await subscriber.subscribe(channel); }
      catch (error) { subscriber.disconnect(); throw error; }
      return async () => { subscriber.removeListener("message", listener); subscriber.disconnect(); };
    },
  };
}
