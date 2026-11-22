import type IORedis from "ioredis";
import {
  isUnconfirmedStreamSealError, markUnconfirmedStreamSeal, parseContextSourceRefs, sealOpeningTutorStream,
  TUTOR_STREAM_TTL_SECONDS, tutorAttemptFenceSchema, tutorStreamAttemptHeadKey, tutorStreamEpochKey, tutorStreamKey,
  tutorStreamPreAnswerHeadKey, UnconfirmedStreamSealError, type ContextSourceRef, type TutorAttemptFence,
  type OpeningTutorJobsRepository,
} from "@aistudy/database";
import { openingMaterialPurposePinSchema, uuidSchema, type OpeningMaterialPurposePin } from "@aistudy/contracts";
export { isUnconfirmedStreamSealError, UnconfirmedStreamSealError };

export type TutorStreamContext = {
  privacyEpoch: number;
  contextSourceRefs: ContextSourceRef[];
  exposureReceiptId: string | null;
  claimToken?: string;
  executionId?: string;
  attemptFence?: TutorAttemptFence;
  attemptSourceRefs?: ContextSourceRef[];
  materialPurposePin?: OpeningMaterialPurposePin;
  memoryLineageSourceIds?: string[];
  globalMemoryIds?: string[];
  historyCourseBindings?: Parameters<OpeningTutorJobsRepository["readStream"]>[2]["historyCourseBindings"];
  temporaryMemoryExpiresAt?: string;
};
export type TutorStreamDelta = { text: string; sequence: number };
export type TutorStreamSnapshot = TutorStreamContext & TutorStreamDelta;
const channelFor = (workspaceId: string, jobId: string) => `${tutorStreamKey(workspaceId, jobId)}:events`;

function attemptHeadBinding(workspaceId: string, fence?: TutorAttemptFence) {
  if (fence?.rootObservationId && fence.headObservationId) {
    const key = tutorStreamAttemptHeadKey(workspaceId, fence.rootObservationId);
    return {
      key,
      revKey: `${key}:rev`,
      id: fence.headObservationId,
      revision: fence.headRevision !== undefined ? String(fence.headRevision) : "",
    };
  }
  if (fence?.rootObservationId === null && fence.headObservationId === null) {
    const key = tutorStreamPreAnswerHeadKey(workspaceId, fence.attemptId);
    return {
      key,
      revKey: `${key}:rev`,
      id: "unsubmitted",
      revision: fence.headRevision !== undefined ? String(fence.headRevision) : "0",
    };
  }
}

const redisTransportCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN",
]);
const redisTransportMessages = new Set([
  "Command timed out", "Connection is closed.", "tutor stream Redis is disconnected",
  "Stream isn't writeable and enableOfflineQueue options is false",
]);

const definitiveRedisReplyCodes = new Set(["ERR", "OOM", "READONLY", "NOPERM", "WRONGPASS", "NOAUTH"]);

/** A Redis reply proves that the specific append EVAL reached Redis and did not mutate state. */
export function isNonMutatingRedisReplyError(error: unknown): boolean {
  return error instanceof Error && error.name === "ReplyError";
}

/** Redis definitively rejected a seal, so retrying could only hold the PG lease longer. */
export function isDefinitiveSealRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = /^-?([A-Z][A-Z0-9_-]*)\b/.exec(error.message.trim())?.[1];
  return code !== undefined && definitiveRedisReplyCodes.has(code);
}

// Preserve the existing exported name for callers while making the seal-only
// meaning explicit at the call sites below.
export const isDefinitiveRedisRejection = isDefinitiveSealRejection;

export function isTutorStreamUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ReplyError") return /^(LOADING|READONLY|CLUSTERDOWN|MASTERDOWN|OOM)\b/.test(error.message);
  if (error.name === "MaxRetriesPerRequestError") return true;
  if (error.name !== "Error" && error.name !== "AggregateError") return false;
  if ("code" in error) return typeof error.code === "string" && redisTransportCodes.has(error.code);
  return redisTransportMessages.has(error.message);
}

const DELTA_BATCH_MAX_BYTES = 256;
const DELTA_BATCH_MAX_MS = 40;
const DELTA_BATCH_BOUNDARY = /[.!?。！？\n]/u;

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
    if (first || DELTA_BATCH_BOUNDARY.test(delta) || Buffer.byteLength(buffer, "utf8") >= DELTA_BATCH_MAX_BYTES
      || performance.now() >= deadline) {
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

export class TutorStreamExpiredError extends Error {
  readonly code = "CONFLICT" as const;
  readonly reasonCode = "TEMPORARY_MEMORY_EXPIRED" as const;
  constructor(message = "stream temporary memory expired") {
    super(message);
    this.name = "TutorStreamExpiredError";
  }
}

export function isTutorStreamExpiredError(error: unknown): boolean {
  return error instanceof TutorStreamExpiredError
    || (error !== null && typeof error === "object" && "reasonCode" in error
      && (error as { reasonCode?: unknown }).reasonCode === "TEMPORARY_MEMORY_EXPIRED");
}

function parseTempExpiryMs(expiresAt: string | number | undefined): number | null {
  if (expiresAt === undefined) return null;
  const ms = typeof expiresAt === "number" ? expiresAt : Date.parse(expiresAt);
  if (!Number.isSafeInteger(ms)) throw new TutorStreamExpiredError("stream temporary memory expiry invalid");
  return ms;
}

/** Redis is temporary presentation state; completed answers and job status remain in PostgreSQL. */
export function createTutorStreamWriter(redis: IORedis) {
  return {
    async begin(workspaceId: string, jobId: string, context: TutorStreamContext) {
      const key = tutorStreamKey(workspaceId, jobId);
      const head = attemptHeadBinding(workspaceId, context.attemptFence);
      const tempExpiresAtMs = parseTempExpiryMs(context.temporaryMemoryExpiresAt);
      const nowMs = Date.now();
      if (tempExpiresAtMs !== null && nowMs >= tempExpiresAtMs) {
        throw new TutorStreamExpiredError();
      }
      const result = await redis.eval(`
        if redis.replicate_commands then redis.replicate_commands() end
        local epoch = tonumber(ARGV[4])
        local minimum = tonumber(redis.call('GET', KEYS[2]) or '0')
        if epoch < minimum then return 0 end
        if redis.call('HGET', KEYS[1], 'executionId') == ARGV[1]
          and redis.call('HGET', KEYS[1], 'sealed') == '1' then return 0 end
        local expMs = tonumber(ARGV[7])
        if ARGV[7] ~= '' and not expMs then
          if redis.call('EXISTS', KEYS[1]) == 1 and (redis.call('HGET', KEYS[1], 'executionId') or '') == ARGV[1] then
            redis.call('HSET', KEYS[1], 'sealed', '1')
          end
          return 'EXPIRED'
        end
        if expMs then
          local t = redis.call('TIME')
          local redisNowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
          local effectiveNowMs = math.max(redisNowMs, tonumber(ARGV[8]) or 0)
          if effectiveNowMs >= expMs then
            if redis.call('EXISTS', KEYS[1]) == 1 and (redis.call('HGET', KEYS[1], 'executionId') or '') == ARGV[1] then
              redis.call('HSET', KEYS[1], 'sealed', '1')
            end
            return 'EXPIRED'
          end
        end
        if ARGV[5] ~= '' then
          local head = redis.call('GET', KEYS[3])
          local cachedRev = tonumber(redis.call('GET', KEYS[4]))
          local jobRev = tonumber(ARGV[6])
          if jobRev and cachedRev then
            if cachedRev > jobRev or (cachedRev == jobRev and head and head ~= ARGV[5]) then return 0 end
          elseif head and head ~= ARGV[5] then
            if not jobRev or jobRev <= 0 then return 0 end
          elseif cachedRev and not jobRev and not head then
            return 0
          end
          if not cachedRev or (jobRev and jobRev >= cachedRev) then
            redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[3])
            if jobRev then
              redis.call('SET', KEYS[4], ARGV[6], 'EX', ARGV[3])
            end
          else
            if not head then redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[3])
            else redis.call('EXPIRE', KEYS[3], ARGV[3]) end
            redis.call('EXPIRE', KEYS[4], ARGV[3])
          end
        end
        redis.call('SET', KEYS[2], epoch, 'EX', ARGV[3])
        redis.call('DEL', KEYS[1])
        redis.call('HSET', KEYS[1], 'executionId', ARGV[1], 'privacyEpoch', ARGV[4], 'context', ARGV[2], 'text', '', 'sequence', '0')
        if ARGV[7] ~= '' then
          redis.call('HSET', KEYS[1], 'temporaryMemoryExpiresAt', ARGV[7])
        end
        if ARGV[5] ~= '' then
          redis.call('HSET', KEYS[1], 'attemptHeadKey', KEYS[3], 'attemptHeadId', ARGV[5])
          if ARGV[6] ~= '' then
            redis.call('HSET', KEYS[1], 'attemptHeadRevision', ARGV[6])
          end
        end
        redis.call('EXPIRE', KEYS[1], ARGV[3])
        return 1
      `, 4, key, tutorStreamEpochKey(workspaceId), head?.key ?? key, head?.revKey ?? key,
      context.executionId ?? "", JSON.stringify({ ...context, historyCourseBindings: context.historyCourseBindings ?? [] }),
      TUTOR_STREAM_TTL_SECONDS, context.privacyEpoch,
      head?.id ?? "", head?.revision ?? "", tempExpiresAtMs !== null ? String(tempExpiresAtMs) : "", nowMs);
      if (result === "EXPIRED") {
        throw new TutorStreamExpiredError();
      }
    },
    seal: (workspaceId: string, jobId: string, executionId: string) => sealOpeningTutorStream(redis, workspaceId, jobId, executionId),
    async append(workspaceId: string, jobId: string, text: string, executionId: string | undefined, privacyEpoch: number,
      attemptFence?: TutorAttemptFence, temporaryMemoryExpiresAt?: string | number): Promise<number> {
      if (!text) return 0;
      const tempExpiresAtMs = parseTempExpiryMs(temporaryMemoryExpiresAt);
      const nowMs = Date.now();
      if (tempExpiresAtMs !== null && nowMs >= tempExpiresAtMs) {
        throw new TutorStreamExpiredError();
      }
      const key = tutorStreamKey(workspaceId, jobId);
      const head = attemptHeadBinding(workspaceId, attemptFence);
      // Append, sequence and notification are one atomic operation. A late subscriber reads the full snapshot.
      const result = await redis.eval(`
        if redis.replicate_commands then redis.replicate_commands() end
        if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
        if (redis.call('HGET', KEYS[1], 'executionId') or '') ~= ARGV[5] then return 0 end
        if redis.call('HGET', KEYS[1], 'sealed') == '1' then return 0 end
        if redis.call('HGET', KEYS[1], 'privacyEpoch') ~= ARGV[6] then return 0 end
        local epoch = tonumber(ARGV[6])
        local minimum = tonumber(redis.call('GET', KEYS[3]))
        if not epoch or not minimum or epoch < minimum then return 0 end
        local rawStoredExp = redis.call('HGET', KEYS[1], 'temporaryMemoryExpiresAt')
        local storedExp = tonumber(rawStoredExp)
        if rawStoredExp and rawStoredExp ~= '' and not storedExp then
          redis.call('HSET', KEYS[1], 'sealed', '1')
          return -1
        end
        local argExp = tonumber(ARGV[4])
        if ARGV[4] ~= '' and not argExp then
          redis.call('HSET', KEYS[1], 'sealed', '1')
          return -1
        end
        local expMs = storedExp
        if argExp and (not expMs or argExp < expMs) then expMs = argExp end
        if expMs then
          local t = redis.call('TIME')
          local redisNowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
          local effectiveNowMs = math.max(redisNowMs, tonumber(ARGV[3]) or 0)
          if effectiveNowMs >= expMs then
            redis.call('HSET', KEYS[1], 'sealed', '1')
            return -1
          end
        end
        local headKey = redis.call('HGET', KEYS[1], 'attemptHeadKey')
        if ARGV[7] ~= '' then
          if headKey ~= KEYS[4] or redis.call('HGET', KEYS[1], 'attemptHeadId') ~= ARGV[7]
            or redis.call('GET', KEYS[4]) ~= ARGV[7] then return 0 end
          redis.call('EXPIRE', KEYS[4], ARGV[2])
          if redis.call('EXISTS', KEYS[5]) == 1 then redis.call('EXPIRE', KEYS[5], ARGV[2]) end
        elseif headKey then
          return 0
        end
        local text = redis.call('HGET', KEYS[1], 'text') or ''
        local sequence = redis.call('HINCRBY', KEYS[1], 'sequence', 1)
        redis.call('HSET', KEYS[1], 'text', text .. ARGV[1])
        redis.call('EXPIRE', KEYS[1], ARGV[2])
        redis.call('EXPIRE', KEYS[3], ARGV[2])
        redis.call('PUBLISH', KEYS[2], cjson.encode({text=ARGV[1], sequence=sequence}))
        return sequence
      `, 5, key, channelFor(workspaceId, jobId), tutorStreamEpochKey(workspaceId), head?.key ?? key, head?.revKey ?? key,
      text, TUTOR_STREAM_TTL_SECONDS, nowMs, tempExpiresAtMs !== null ? String(tempExpiresAtMs) : "",
      executionId ?? "", privacyEpoch, head?.id ?? "");
      if (result === -1) throw new TutorStreamExpiredError();
      if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new Error("invalid stream publication sequence");
      return result;
    },
  };
}
export type TutorStreamWriter = ReturnType<typeof createTutorStreamWriter>;

export const DEFAULT_SEAL_DEADLINE_MS = 1_500;
const DEFAULT_SEAL_RETRY_INTERVAL_MS = 500;

export type WorkerTutorStreamWriterOptions = {
  sealDeadlineMs?: number;
  sealRetryIntervalMs?: number;
};

/** The worker holds PostgreSQL publication locks until this append settles. */
export function createWorkerTutorStreamWriter(
  producer: IORedis,
  reportError: (error: unknown) => void,
  options: WorkerTutorStreamWriterOptions = {},
) {
  // Control and append both own their sockets so a timeout never closes the queue producer.
  let controlConnection: ReturnType<typeof openConnection> | undefined;
  let appendConnection: ReturnType<typeof openConnection> | undefined;

  function openConnection(control = false) {
    const redis = producer.duplicate({ lazyConnect: true, autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    let definitiveError: Error | undefined;
    redis.on("error", control ? (error: Error) => {
      // ioredis emits a fatal handshake reply before connect rejects on close.
      if (!definitiveError && isDefinitiveSealRejection(error)) definitiveError = error;
      reportError(error);
    } : reportError);
    const ready = redis.connect().then(async () => {
      // ioredis emits initial SELECT failures without rejecting connect().
      if (redis.options?.db) await redis.select(redis.options.db);
    });
    return { redis, writer: createTutorStreamWriter(redis), ready, get definitiveError() { return definitiveError; } };
  }

  function closeConnection(redis: IORedis) {
    redis.disconnect();
    // ioredis starts a graceful close. Discard unsent data immediately.
    redis.stream?.destroy();
  }

  function disconnectAppend(connection = appendConnection) {
    if (!connection || connection !== appendConnection) return;
    appendConnection = undefined;
    closeConnection(connection.redis);
  }

  function retireControl(connection = controlConnection) {
    if (!connection || connection !== controlConnection) return;
    controlConnection = undefined;
    closeConnection(connection.redis);
  }

  const isClosed = (redis: IORedis) => redis.status === "end" || redis.status === "close";
  async function seal(workspaceId: string, jobId: string, executionId: string) {
    if (controlConnection && isClosed(controlConnection.redis)) retireControl();
    const connection = controlConnection ??= openConnection(true);
    try {
      await connection.ready;
      await connection.writer.seal(workspaceId, jobId, executionId);
    } catch (error) {
      retireControl(connection);
      throw connection.definitiveError ?? error;
    }
  }

  async function getAppendConnection() {
    if (appendConnection && isClosed(appendConnection.redis)) disconnectAppend();
    const connection = appendConnection ??= openConnection();
    try {
      await connection.ready;
      if (connection.redis.status !== "ready") throw new Error("tutor stream Redis is disconnected");
    } catch (error) {
      disconnectAppend(connection);
      throw error;
    }
    return connection;
  }

  async function sealUntilConfirmed(workspaceId: string, jobId: string, executionId: string, appendError: unknown) {
    const deadlineMs = Math.max(1, options.sealDeadlineMs ?? DEFAULT_SEAL_DEADLINE_MS);
    const retryIntervalMs = Math.max(1, options.sealRetryIntervalMs ?? DEFAULT_SEAL_RETRY_INTERVAL_MS);
    let reported = false;
    let expired = false;
    let lastSealError: unknown;
    let rejectDeadline!: (error: Error) => void;
    const deadlineReached = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    void deadlineReached.catch(() => undefined);
    const timer = setTimeout(() => {
      expired = true;
      retireControl();
      const timeoutError = lastSealError ?? new Error(`tutor stream seal timed out after ${deadlineMs}ms`);
      if (!reported) {
        reportError(timeoutError);
        reported = true;
      }
      rejectDeadline(new UnconfirmedStreamSealError(appendError, timeoutError));
    }, deadlineMs);
    try {
      for (;;) {
        if (expired) {
          throw new UnconfirmedStreamSealError(
            appendError,
            lastSealError ?? new Error(`tutor stream seal timed out after ${deadlineMs}ms`),
          );
        }
        try {
          const attempt = seal(workspaceId, jobId, executionId);
          void attempt.catch(() => undefined);
          await Promise.race([attempt, deadlineReached]);
          return;
        } catch (error) {
          if (isUnconfirmedStreamSealError(error)) throw error;
          lastSealError = error;
          if (isDefinitiveSealRejection(error)) {
            markUnconfirmedStreamSeal(error);
            throw error;
          }
          if (expired) throw new UnconfirmedStreamSealError(appendError, error);
          if (reported) {
            let retryTimer: ReturnType<typeof setTimeout> | undefined;
            const retryWait = new Promise<void>(resolve => { retryTimer = setTimeout(resolve, retryIntervalMs); });
            try { await Promise.race([retryWait, deadlineReached]); }
            finally { clearTimeout(retryTimer); }
          } else {
            reportError(error);
          }
          reported = true;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const activeTempExpiryMs = new Map<string, { expMs: number; touchedAt: number }>();
  const streamExpiryKey = (workspaceId: string, jobId: string, executionId: string | undefined) =>
    `${workspaceId}:${jobId}:${executionId ?? ""}`;
  const pruneTrackedExpiries = (nowMs: number) => {
    const staleBefore = nowMs - TUTOR_STREAM_TTL_SECONDS * 1000;
    for (const [key, entry] of activeTempExpiryMs) {
      if (entry.expMs <= nowMs || entry.touchedAt < staleBefore) activeTempExpiryMs.delete(key);
    }
  };

  return {
    async begin(...args: Parameters<TutorStreamWriter["begin"]>) {
      const [workspaceId, jobId, context] = args;
      const expMs = parseTempExpiryMs(context.temporaryMemoryExpiresAt);
      const beforeNowMs = Date.now();
      pruneTrackedExpiries(beforeNowMs);
      if (expMs !== null && beforeNowMs >= expMs) {
        throw new TutorStreamExpiredError();
      }
      const connection = await getAppendConnection();
      // Re-check synchronously AFTER awaiting Redis connect/reconnect, right before sending EVAL.
      const afterNowMs = Date.now();
      if (expMs !== null && afterNowMs >= expMs) {
        throw new TutorStreamExpiredError();
      }
      const trackingKey = streamExpiryKey(workspaceId, jobId, context.executionId);
      if (expMs !== null) activeTempExpiryMs.set(trackingKey, { expMs, touchedAt: afterNowMs });
      else activeTempExpiryMs.delete(trackingKey);
      try { await connection.writer.begin(...args); }
      catch (error) {
        if (isTutorStreamExpiredError(error)) {
          activeTempExpiryMs.delete(trackingKey);
          throw error;
        }
        disconnectAppend(connection);
        throw error;
      }
    },
    async seal(workspaceId: string, jobId: string, executionId: string) {
      activeTempExpiryMs.delete(streamExpiryKey(workspaceId, jobId, executionId));
      return seal(workspaceId, jobId, executionId);
    },
    disconnect() {
      activeTempExpiryMs.clear();
      disconnectAppend();
      retireControl();
    },
    async append(...args: Parameters<TutorStreamWriter["append"]>) {
      const [workspaceId, jobId, text, executionId, privacyEpoch, attemptFence, temporaryMemoryExpiresAt] = args;
      if (!text) return 0;
      const argExpMs = parseTempExpiryMs(temporaryMemoryExpiresAt);
      const trackingKey = streamExpiryKey(workspaceId, jobId, executionId);
      const tracked = activeTempExpiryMs.get(trackingKey);
      const effectiveExpMs = argExpMs !== null && tracked !== undefined
        ? Math.min(argExpMs, tracked.expMs)
        : (argExpMs ?? tracked?.expMs ?? null);
      if (effectiveExpMs !== null && Date.now() >= effectiveExpMs) {
        activeTempExpiryMs.delete(trackingKey);
        throw new TutorStreamExpiredError();
      }
      const connection = await getAppendConnection();
      // Re-check synchronously AFTER awaiting Redis connect/reconnect, right before sending EVAL.
      const afterNowMs = Date.now();
      if (effectiveExpMs !== null && afterNowMs >= effectiveExpMs) {
        activeTempExpiryMs.delete(trackingKey);
        throw new TutorStreamExpiredError();
      }
      if (tracked) tracked.touchedAt = afterNowMs;
      try {
        return await connection.writer.append(
          workspaceId, jobId, text, executionId, privacyEpoch, attemptFence,
          effectiveExpMs !== null ? effectiveExpMs : undefined,
        );
      } catch (error) {
        if (isTutorStreamExpiredError(error)) {
          activeTempExpiryMs.delete(trackingKey);
          throw error;
        }
        disconnectAppend(connection);
        if (isNonMutatingRedisReplyError(error)) throw error;
        // Redis may still execute bytes already in transit. Try to confirm a
        // seal within a bounded deadline; on expiry, throw UnconfirmedStreamSealError
        // so withStreamPublication fences the execution in PostgreSQL before releasing locks.
        await sealUntilConfirmed(workspaceId, jobId, executionId ?? "", error);
        throw error;
      }
    },
  };
}

function parseHistoryCourseBindings(value: unknown): NonNullable<TutorStreamContext["historyCourseBindings"]> {
  if (!Array.isArray(value)) throw new Error("invalid tutor stream cache");
  const isUuidList = (ids: unknown): ids is string[] =>
    Array.isArray(ids) && ids.every(id => uuidSchema.safeParse(id).success);
  const normalizeIds = (ids: string[]) => [...new Set(ids.map(id => id.toLowerCase()))];
  return value.map(binding => {
    if (!binding || typeof binding !== "object"
      || Object.keys(binding).some(key => !["courseId", "materialUse", "sourceIds", "sourceRefs", "memoryIds", "memoryBackings"].includes(key))
      || !(binding.courseId === null || uuidSchema.safeParse(binding.courseId).success)
      || (binding.materialUse !== "citation" && binding.materialUse !== "practice")
      || !isUuidList(binding.sourceIds)
      || !Array.isArray(binding.sourceRefs) || binding.sourceRefs.some((ref: ContextSourceRef) =>
        !ref || typeof ref !== "object" || !uuidSchema.safeParse(ref.sourceId).success || ref.memoryOnly === true)
      || (binding.memoryIds !== undefined && !isUuidList(binding.memoryIds))
      || (binding.memoryBackings !== undefined && (!Array.isArray(binding.memoryBackings)
        || binding.memoryBackings.some((ids: unknown) => !isUuidList(ids) || !ids.length)))) {
      throw new Error("invalid tutor stream cache");
    }
    const sourceRefs = parseContextSourceRefs(binding.sourceRefs);
    const sourceIds = normalizeIds(binding.sourceIds).sort();
    if (!sourceRefs || sourceRefs.some(ref => !sourceIds.includes(ref.sourceId))) throw new Error("invalid tutor stream cache");
    return { courseId: binding.courseId?.toLowerCase() ?? null, materialUse: binding.materialUse, sourceIds, sourceRefs,
      ...(binding.memoryIds !== undefined ? { memoryIds: normalizeIds(binding.memoryIds).sort() } : {}),
      ...(binding.memoryBackings !== undefined ? { memoryBackings: binding.memoryBackings.map(normalizeIds) } : {}),
    };
  });
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
  const attemptSourceRefs = context.attemptSourceRefs === undefined ? undefined : parseContextSourceRefs(context.attemptSourceRefs);
  if (attemptSourceRefs === null || (attemptSourceRefs && !fence)) throw new Error("invalid tutor stream cache");
  const historyCourseBindings = parseHistoryCourseBindings(context.historyCourseBindings);
  const materialPurposePin = context.materialPurposePin === undefined ? undefined
    : openingMaterialPurposePinSchema.parse(context.materialPurposePin);
  let memoryLineageSourceIds: string[] | undefined;
  if (context.memoryLineageSourceIds !== undefined) {
    if (!Array.isArray(context.memoryLineageSourceIds)
      || context.memoryLineageSourceIds.some(id => !uuidSchema.safeParse(id).success)) {
      throw new Error("invalid tutor stream cache");
    }
    memoryLineageSourceIds = [...new Set(context.memoryLineageSourceIds.map(id => id.toLowerCase()))].sort();
  }
  let globalMemoryIds: string[] | undefined;
  if (context.globalMemoryIds !== undefined) {
    if (!Array.isArray(context.globalMemoryIds)
      || context.globalMemoryIds.some(id => !uuidSchema.safeParse(id).success)) {
      throw new Error("invalid tutor stream cache");
    }
    globalMemoryIds = [...new Set(context.globalMemoryIds.map(id => id.toLowerCase()))].sort();
  }
  let temporaryMemoryExpiresAt: string | undefined;
  if (context.temporaryMemoryExpiresAt !== undefined) {
    if (typeof context.temporaryMemoryExpiresAt !== "string" || Number.isNaN(Date.parse(context.temporaryMemoryExpiresAt))) {
      throw new Error("invalid tutor stream cache");
    }
    temporaryMemoryExpiresAt = context.temporaryMemoryExpiresAt;
  }
  return { ...context, ...(fence ? { attemptFence: fence } : {}),
    ...(attemptSourceRefs ? { attemptSourceRefs } : {}),
    historyCourseBindings,
    ...(materialPurposePin ? { materialPurposePin } : {}),
    ...(memoryLineageSourceIds ? { memoryLineageSourceIds } : {}),
    ...(globalMemoryIds ? { globalMemoryIds } : {}),
    ...(temporaryMemoryExpiresAt ? { temporaryMemoryExpiresAt } : {}),
    contextSourceRefs: refs, text: row.text, sequence };
}

export function createTutorStreamReader(redis: IORedis) {
  return {
    async read(workspaceId: string, jobId: string): Promise<TutorStreamSnapshot | null> {
      return parseSnapshot(await redis.hgetall(tutorStreamKey(workspaceId, jobId)));
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
