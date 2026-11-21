import { connect, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import { parse } from "node:url";
import type { TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export const TUTOR_STREAM_TTL_SECONDS = 15 * 60;

const unconfirmedStreamSealErrors = new WeakSet<object>();

export class UnconfirmedStreamSealError extends Error {
  readonly code = "UNCONFIRMED_STREAM_SEAL" as const;
  override readonly cause: unknown;
  readonly sealError: unknown;
  constructor(cause: unknown, sealError: unknown) {
    super(
      `tutor stream seal was not confirmed before deadline: ${
        sealError instanceof Error ? sealError.message : "unknown seal error"
      }`,
    );
    this.name = "UnconfirmedStreamSealError";
    this.cause = cause;
    this.sealError = sealError;
  }
}

/** Mark a definitive seal rejection without altering the rejected error identity. */
export function markUnconfirmedStreamSeal(error: unknown): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    unconfirmedStreamSealErrors.add(error);
  }
}

export function isUnconfirmedStreamSealError(error: unknown): boolean {
  if (error instanceof UnconfirmedStreamSealError) return true;
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    if (unconfirmedStreamSealErrors.has(error)) return true;
    return "code" in error && (error as { code?: unknown }).code === "UNCONFIRMED_STREAM_SEAL";
  }
  return false;
}
export const tutorStreamKey = (workspaceId: string, jobId: string) =>
  `opening:tutor-stream:${workspaceId.trim().toLowerCase()}:${jobId.trim().toLowerCase()}`;
export const tutorStreamEpochKey = (workspaceId: string) => `opening:tutor-stream:epoch:${workspaceId.trim().toLowerCase()}`;
export const tutorStreamAttemptHeadKey = (workspaceId: string, rootObservationId: string) =>
  `opening:tutor-stream:attempt-head:${workspaceId.trim().toLowerCase()}:${rootObservationId.trim().toLowerCase()}`;
export const tutorStreamPreAnswerHeadKey = (workspaceId: string, attemptId: string) =>
  `opening:tutor-stream:attempt-head:${workspaceId.trim().toLowerCase()}:unsubmitted:${attemptId.trim().toLowerCase()}`;

type RedisQueryValue = string | string[];
type OpeningRedisConnectionOptions = {
  host: RedisQueryValue;
  port: number | string[];
  family: number | RedisQueryValue;
  path?: RedisQueryValue;
  username?: RedisQueryValue;
  password?: RedisQueryValue;
  db: number | string[];
  tls?: true | RedisQueryValue;
};

function parseRedisNumber(value: number | RedisQueryValue): number | string[] {
  return typeof value === "string" ? Number.parseInt(value, 10) : value;
}

/** Resolve the standalone endpoint with ioredis 5.6.1 URL precedence. */
export function openingRedisConnectionOptions(redisUrl: string): OpeningRedisConnectionOptions {
  const defaults = { host: "localhost", family: 4, db: 0 };
  const numericUrl = Number.parseFloat(redisUrl);
  if (!Number.isNaN(Number(redisUrl)) && (numericUrl | 0) === numericUrl) {
    return { ...defaults, port: Number.parseInt(redisUrl, 10) };
  }

  let parsed = parse(redisUrl, true, true);
  if (!parsed.slashes && !redisUrl.startsWith("/")) parsed = parse(`//${redisUrl}`, true, true);
  const redisProtocol = parsed.protocol === "redis:" || parsed.protocol === "rediss:";
  if (parsed.protocol !== null && !redisProtocol) {
    throw new Error("Invalid Redis fence URL");
  }

  const query = parsed.query as Record<string, RedisQueryValue | undefined>;
  const auth = parsed.auth;
  const authSeparator = auth?.indexOf(":") ?? -1;
  const db = redisProtocol && parsed.pathname && parsed.pathname.length > 1 ? parsed.pathname.slice(1) : query.db;
  const numericFamily = typeof query.family === "string" ? Number.parseInt(query.family, 10) : Number.NaN;
  return {
    host: (parsed.host ? parsed.hostname : null) ?? query.host ?? defaults.host,
    port: parseRedisNumber(parsed.port ?? query.port ?? 6379),
    family: Number.isNaN(numericFamily) ? query.family ?? defaults.family : numericFamily,
    path: (redisProtocol ? null : parsed.pathname) ?? query.path,
    username: auth ? (authSeparator < 0 ? auth : auth.slice(0, authSeparator)) : query.username,
    password: auth ? (authSeparator < 0 ? "" : auth.slice(authSeparator + 1)) : query.password,
    db: parseRedisNumber(db ?? defaults.db),
    tls: query.tls ?? (redisUrl.startsWith("rediss://") ? true : undefined),
  };
}

/** Validate usable options before Redis can accept commands on an unintended database. */
export function openingRedisEndpoint(redisUrl: string) {
  const url = redisUrl.trim();
  if (!url) throw new Error("Invalid Redis fence URL");
  const { host, port, family, path, db, username, password, tls } = openingRedisConnectionOptions(url);
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid Redis port");
  if (typeof db !== "number" || !Number.isSafeInteger(db) || db < 0) throw new Error("Invalid Redis database index");
  if (typeof family !== "number" || !Number.isSafeInteger(family) || family < 0) throw new Error("Invalid Redis address family");
  if (typeof host !== "string" || Array.isArray(path) || Array.isArray(username) || Array.isArray(password) || Array.isArray(tls)) {
    throw new Error("Ambiguous Redis endpoint options");
  }
  if (!tls && /^rediss:/i.test(url)) throw new Error("Redis TLS is required for rediss URLs");
  return { url, host, port, family, path, db, username, password, tls };
}

export function openingRedisDatabase(redisUrl: string): number {
  return openingRedisEndpoint(redisUrl).db;
}

export async function sealOpeningTutorStream(redis: RedisEval, workspaceId: string, jobId: string, executionId: string) {
  await redis.eval(`
    local execution = redis.call('HGET', KEYS[1], 'executionId')
    if execution == ARGV[1] then
      redis.call('HSET', KEYS[1], 'sealed', '1')
    elseif not execution then
      -- Cancellation may arrive before the worker initializes its cache.
      redis.call('HSET', KEYS[1], 'executionId', ARGV[1], 'sealed', '1')
      redis.call('EXPIRE', KEYS[1], ARGV[2])
    end
  `, 1, tutorStreamKey(workspaceId, jobId), executionId, TUTOR_STREAM_TTL_SECONDS);
}

type RedisArgument = string | number;
type RedisEval = { eval(script: string, keyCount: number, ...args: RedisArgument[]): Promise<unknown> };
type RespValue = string | Buffer | bigint | null | RespValue[];
type RespFrame = { value: RespValue; end: number };

const CRLF = "\r\n";
// These dedicated sockets receive only AUTH/SELECT acknowledgments and the EVAL reply.
const MAX_REPLY_BYTES = 64 * 1024;
const FENCE_TIMEOUT_MS = 2_000;

function readRespFrame(bytes: Buffer, start = 0, depth = 0): RespFrame | undefined {
  const lineEnd = bytes.indexOf(CRLF, start);
  if (lineEnd === -1) return;
  const header = bytes.toString("utf8", start + 1, lineEnd);
  const end = lineEnd + CRLF.length;
  const type = String.fromCharCode(bytes[start]!);
  if (depth > 64 || /[\r\n]/.test(header)) throw new Error("Invalid Redis response");
  if (type === "+") return { value: header, end };
  if (type === "-") throw new Error(header);
  if (!/^[+-]?\d+$/.test(header)) throw new Error("Invalid Redis response");
  if (type === ":") {
    const value = BigInt(header);
    if (BigInt.asIntN(64, value) !== value) throw new Error("Invalid Redis integer");
    return { value, end };
  }
  if (type !== "$" && type !== "*") throw new Error("Invalid Redis response type");
  const length = Number(header);
  if (length === -1) return { value: null, end };
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REPLY_BYTES) throw new Error("Invalid Redis response length");
  if (type === "$") {
    const bulkEnd = end + length;
    if (bytes.length < bulkEnd + CRLF.length) return;
    if (bytes[bulkEnd] !== 13 || bytes[bulkEnd + 1] !== 10) throw new Error("Invalid Redis bulk string");
    return { value: bytes.subarray(end, bulkEnd), end: bulkEnd + CRLF.length };
  }
  const values: RespValue[] = [];
  let next = end;
  for (let i = 0; i < length; i++) {
    const frame = readRespFrame(bytes, next, depth + 1);
    if (!frame) return;
    values.push(frame.value);
    next = frame.end;
  }
  return { value: values, end: next };
}

function redisCommand(args: RedisArgument[]): Buffer {
  const chunks = [Buffer.from("*" + args.length + CRLF)];
  for (const arg of args) {
    const value = Buffer.from(String(arg), "utf8");
    chunks.push(Buffer.from("$" + value.length + CRLF), value, Buffer.from(CRLF));
  }
  return Buffer.concat(chunks);
}

/** One connection and one deadline for connect, optional AUTH/SELECT, and EVAL. */
async function evalRevocationRedis(redisUrl: string, script: string, keyCount: number, ...args: RedisArgument[]): Promise<void> {
  const { host, port, family, path, db, username, password, tls } = openingRedisEndpoint(redisUrl);
  const useTls = Boolean(tls);
  const commands: RedisArgument[][] = [];
  if (password) commands.push(username ? ["AUTH", username, password] : ["AUTH", password]);
  if (db) commands.push(["SELECT", db]);
  commands.push(["EVAL", script, keyCount, ...args]);

  await new Promise<void>((resolve, reject) => {
    const connectionOptions = path ? { path } : { host, port, family };
    const socket = useTls
      ? connectTls({ ...connectionOptions, ...(path || isIP(host) ? {} : { servername: host }) })
      : connect(connectionOptions);
    let pending: Buffer = Buffer.alloc(0);
    let command = 0;
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error("Redis fence timed out")), FENCE_TIMEOUT_MS);
    const send = () => socket.write(redisCommand(commands[command]!));
    socket.once(useTls ? "secureConnect" : "connect", send);
    socket.on("error", finish);
    socket.once("end", () => finish(new Error("Redis closed before confirming the fence")));
    socket.on("data", chunk => {
      try {
        if (pending.length + chunk.length > MAX_REPLY_BYTES) throw new Error("Redis fence response is too large");
        pending = Buffer.concat([pending, chunk]);
        const frame = readRespFrame(pending);
        if (!frame) return;
        const last = command === commands.length - 1;
        if (frame.end !== pending.length || frame.value !== (last ? null : "OK")) {
          throw new Error("Unexpected Redis fence response");
        }
        if (last) { finish(); return; }
        pending = Buffer.alloc(0);
        command++;
        send();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Invalid Redis fence response"));
      }
    });
  });
}

export async function fenceCancelledOpeningTutorStream(workspaceId: string, jobId: string, executionId: string,
  redisUrl = process.env.REDIS_URL?.trim()) {
  if (!redisUrl) throw new Error("Redis is required to cancel a claimed tutor execution");
  await sealOpeningTutorStream({ eval: (script, keyCount, ...args) => evalRevocationRedis(redisUrl, script, keyCount, ...args) },
    workspaceId, jobId, executionId);
}

/** Call while holding the workspace history and attempt or observation root locks. */
export async function fenceOpeningTutorAttemptHead(tx: TransactionSql, workspaceId: string, attemptId: string,
  rootObservationId: string | null, headObservationId: string,
  redisUrl = process.env.REDIS_URL?.trim()): Promise<void> {
  // A terminal claim can still have Redis bytes in flight. New publications
  // must acquire the history lock and check the attempt again after commit.
  const [execution] = await tx`SELECT 1 FROM opening_tutor_jobs j
    JOIN opening_turns t ON t.id=j.user_turn_id AND t.workspace_id=j.workspace_id AND t.conversation_id=j.conversation_id
    WHERE j.workspace_id=${workspaceId} AND j.timing_execution_id IS NOT NULL
      AND (t.attempt_id=${attemptId} OR (t.attempt_id IS NULL AND lower(t.context_anchor->>'attemptId')=${attemptId})) LIMIT 1`;
  if (!execution) return;
  if (!redisUrl) throw new Error("Redis is required to revoke tutor attempt stream publication");
  const key = rootObservationId === null ? tutorStreamPreAnswerHeadKey(workspaceId, attemptId)
    : tutorStreamAttemptHeadKey(workspaceId, rootObservationId);
  // Outlive existing stream snapshots, while bounding the effect of a failed PG commit.
  await evalRevocationRedis(redisUrl, `
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  `, 1, key, headObservationId, TUTOR_STREAM_TTL_SECONDS);
}

/** Call inside the revocation transaction, before it can commit. */
export async function advanceOpeningWorkspacePrivacyEpoch(tx: TransactionSql, scope: OpeningScope,
  redisUrl = process.env.REDIS_URL?.trim()): Promise<number> {
  const [workspace] = await tx`UPDATE workspaces SET privacy_epoch=privacy_epoch+1, updated_at=now()
    WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} RETURNING id,privacy_epoch`;
  if (!workspace) throw new Error("Workspace disappeared while revoking tutor stream eligibility");
  const epoch = Number(workspace.privacy_epoch);

  if (!redisUrl) {
    // A claimed execution can have unresolved bytes even after a terminal job write.
    const [execution] = await tx`SELECT 1 FROM opening_tutor_jobs
      WHERE workspace_id=${workspace.id} AND timing_execution_id IS NOT NULL LIMIT 1`;
    if (execution) throw new Error("Redis is required to revoke tutor stream publication");
    return epoch;
  }
  // The fence outlives existing snapshots. Expiry also bounds the cache
  // disruption if Redis confirms and the subsequent PostgreSQL commit fails.
  await evalRevocationRedis(redisUrl, `
    local minimum = tonumber(redis.call('GET', KEYS[1]) or '0')
    redis.call('SET', KEYS[1], math.max(minimum, tonumber(ARGV[1])), 'EX', ARGV[2])
  `, 1, tutorStreamEpochKey(String(workspace.id)), epoch, TUTOR_STREAM_TTL_SECONDS);
  return epoch;
}
