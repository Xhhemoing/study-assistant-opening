import type { AppEnv } from "@aistudy/config";
import type { DependencyStatus } from "@aistudy/contracts";
import {
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import postgres from "postgres";

async function withLatency(
  run: () => Promise<void>,
): Promise<DependencyStatus> {
  const started = Date.now();
  try {
    await run();
    return { status: "up", latencyMs: Date.now() - started };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - started,
      errorCode: "unreachable",
    };
  }
}

export async function checkDatabase(
  databaseUrl: string,
): Promise<DependencyStatus> {
  return withLatency(async () => {
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 3 });
    try {
      await sql`select 1`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
}

export async function checkRedis(redisUrl: string): Promise<DependencyStatus> {
  return withLatency(async () => {
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });
    try {
      await redis.connect();
      const pong = await redis.ping();
      if (pong !== "PONG") {
        throw new Error("unexpected ping response");
      }
    } finally {
      redis.disconnect();
    }
  });
}

export async function checkStorage(
  s3: AppEnv["s3"],
): Promise<DependencyStatus> {
  return withLatency(async () => {
    const client = new S3Client({
      region: s3.region,
      endpoint: s3.endpoint,
      forcePathStyle: s3.forcePathStyle,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: s3.bucket }));
    } finally {
      client.destroy();
    }
  });
}
