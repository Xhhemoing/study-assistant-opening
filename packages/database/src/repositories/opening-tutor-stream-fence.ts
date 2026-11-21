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

/** Match ioredis 5.6.1's URL precedence and decimal conversion. */
export function openingRedisDatabase(redisUrl: string): number {
  const { pathname, query } = parse(redisUrl, true, true);
  // A nonempty pathname takes precedence over db. "database" is not an ioredis option.
  const raw = pathname && pathname.length > 1 ? pathname.slice(1) : query.db;
  if (raw === undefined) return 0;
  const db = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isSafeInteger(db) || db < 0) throw new Error("Invalid Redis database index");
  return db;
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
  const url = new URL(redisUrl);
  const useTls = url.protocol === "rediss:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || "6379");
  if ((!useTls && url.protocol !== "redis:") || !host) {
    throw new Error("Invalid Redis fence URL");
  }
  const db = openingRedisDatabase(redisUrl);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const commands: RedisArgument[][] = [];
  if (username || password) commands.push(username ? ["AUTH", username, password] : ["AUTH", password]);
  if (db) commands.push(["SELECT", db]);
  commands.push(["EVAL", script, keyCount, ...args]);

  await new Promise<void>((resolve, reject) => {
    const socket = useTls ? connectTls({ host, port, ...(isIP(host) ? {} : { servername: host }) }) : connect({ host, port });
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
