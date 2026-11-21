import { connect, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import { parse } from "node:url";
import type { TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export const TUTOR_STREAM_TTL_SECONDS = 15 * 60;
export const tutorStreamKey = (workspaceId: string, jobId: string) => `opening:tutor-stream:${workspaceId}:${jobId}`;
export const tutorStreamEpochKey = (workspaceId: string) => `opening:tutor-stream:epoch:${workspaceId.toLowerCase()}`;
export const tutorStreamAttemptHeadKey = (workspaceId: string, rootObservationId: string) =>
  `opening:tutor-stream:attempt-head:${workspaceId}:${rootObservationId}`;
export const tutorStreamPreAnswerHeadKey = (workspaceId: string, attemptId: string) =>
  `opening:tutor-stream:attempt-head:${workspaceId.toLowerCase()}:unsubmitted:${attemptId.toLowerCase()}`;

export type OpeningRedisConnectionOptions = {
  host: string;
  port: number;
  family: number;
  path?: string;
  username?: string;
  password?: string;
  db: number;
  tls?: object;
};

/** Resolve the standalone endpoint with ioredis 5.6.1 URL precedence. */
export function openingRedisConnectionOptions(redisUrl: string): OpeningRedisConnectionOptions {
  let parsed = parse(redisUrl, true, true);
  if (!parsed.slashes && !redisUrl.startsWith("/")) {
    parsed = parse("//" + redisUrl, true, true);
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("Invalid Redis fence URL");
  }
  const query = parsed.query as Record<string, string | undefined>;
  const auth = parsed.auth;
  const authSeparator = auth?.indexOf(":") ?? -1;
  const username = auth === null || auth === undefined
    ? query.username
    : authSeparator === -1 ? auth : auth.slice(0, authSeparator);
  const password = auth === null || auth === undefined
    ? query.password
    : authSeparator === -1 ? "" : auth.slice(authSeparator + 1);
  const rawPort = parsed.port ?? query.port ?? "6379";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid Redis port");
  const rawDb = parsed.pathname && parsed.pathname.length > 1 ? parsed.pathname.slice(1) : query.db;
  const db = rawDb === undefined ? 0 : Number.parseInt(rawDb, 10);
  if (!Number.isSafeInteger(db) || db < 0) throw new Error("Invalid Redis database index");
  const rawFamily = query.family;
  const family = rawFamily === undefined ? 4 : Number.parseInt(rawFamily, 10);
  if (!Number.isSafeInteger(family) || family < 0) throw new Error("Invalid Redis address family");
  const options: OpeningRedisConnectionOptions = {
    host: parsed.hostname || query.host || "localhost", port, family, db,
    ...(typeof query.path === "string" ? { path: query.path } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(parsed.protocol === "rediss:" || query.tls !== undefined && Boolean(query.tls) ? { tls: {} } : {}),
  };
  return options;
}

/** Match ioredis 5.6.1's URL precedence and decimal conversion. */
export function openingRedisDatabase(redisUrl: string): number {
  return openingRedisConnectionOptions(redisUrl).db;
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
  const options = openingRedisConnectionOptions(redisUrl);
  const useTls = options.tls !== undefined;
  const host = options.host.replace(/^\[|\]$/g, "");
  const { port, family, path, db, username, password } = options;
  const commands: RedisArgument[][] = [];
  if (username !== undefined || password !== undefined) {
    if (username) commands.push(["AUTH", username, password ?? ""]);
    else if (password !== undefined) commands.push(["AUTH", password]);
  }
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
