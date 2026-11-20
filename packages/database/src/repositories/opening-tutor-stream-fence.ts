import { Redis } from "ioredis";
import type { TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export const TUTOR_STREAM_TTL_SECONDS = 15 * 60;
export const tutorStreamKey = (workspaceId: string, jobId: string) => `opening:tutor-stream:${workspaceId}:${jobId}`;
export const tutorStreamEpochKey = (workspaceId: string) => `opening:tutor-stream:epoch:${workspaceId}`;

export async function sealOpeningTutorStream(redis: Pick<Redis, "eval">, workspaceId: string, jobId: string, executionId: string) {
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

async function withRevocationRedis(redisUrl: string, fence: (redis: Redis) => Promise<unknown>) {
  const redis = new Redis(redisUrl, {
    lazyConnect: true, enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 0, connectTimeout: 2_000, commandTimeout: 2_000, retryStrategy: () => null,
  });
  // connect() and the command promise both report failures to the transaction.
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await fence(redis);
  } finally {
    redis.disconnect();
  }
}

export async function fenceCancelledOpeningTutorStream(workspaceId: string, jobId: string, executionId: string,
  redisUrl = process.env.REDIS_URL?.trim()) {
  if (!redisUrl) throw new Error("Redis is required to cancel a claimed tutor execution");
  await withRevocationRedis(redisUrl, redis => sealOpeningTutorStream(redis, workspaceId, jobId, executionId));
}

/** Call inside the revocation transaction, before it can commit. */
export async function advanceOpeningWorkspacePrivacyEpoch(tx: TransactionSql, scope: OpeningScope): Promise<number> {
  const [workspace] = await tx`UPDATE workspaces SET privacy_epoch=privacy_epoch+1, updated_at=now()
    WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} RETURNING privacy_epoch`;
  if (!workspace) throw new Error("Workspace disappeared while revoking tutor stream eligibility");
  const epoch = Number(workspace.privacy_epoch);
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    // A claimed execution can have unresolved bytes even after a terminal job write.
    const [execution] = await tx`SELECT 1 FROM opening_tutor_jobs
      WHERE workspace_id=${scope.workspaceId} AND timing_execution_id IS NOT NULL LIMIT 1`;
    if (execution) throw new Error("Redis is required to revoke tutor stream publication");
    return epoch;
  }
  // The fence outlives existing snapshots. Expiry also bounds the cache
  // disruption if Redis confirms and the subsequent PostgreSQL commit fails.
  await withRevocationRedis(redisUrl, redis => redis.eval(`
    local minimum = tonumber(redis.call('GET', KEYS[1]) or '0')
    redis.call('SET', KEYS[1], math.max(minimum, tonumber(ARGV[1])), 'EX', ARGV[2])
  `, 1, tutorStreamEpochKey(scope.workspaceId), epoch, TUTOR_STREAM_TTL_SECONDS));
  return epoch;
}
