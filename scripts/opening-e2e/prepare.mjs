import Redis from "ioredis";
import postgres from "postgres";
import { prepareOpeningE2eStorage } from "./storage.mjs";
import { assertOpeningE2eDatabase } from "./environment.mjs";

export async function prepareOpeningE2e(env) {
  assertOpeningE2eDatabase(env.E2E_DATABASE_URL, env.OPENING_E2E);
  if (env.DATABASE_URL !== env.E2E_DATABASE_URL || env.REDIS_URL !== "redis://127.0.0.1:16379/0" ||
      env.S3_ENDPOINT !== "http://127.0.0.1:19000" || env.S3_BUCKET !== "opening-e2e" ||
      env.PUBLIC_BASE_URL !== "http://127.0.0.1:3100") throw new Error("Refusing modified isolated service configuration");
  const sql = postgres(env.E2E_DATABASE_URL, { connect_timeout: 5 });
  try {
    const result = await sql`SELECT current_database() AS name`;
    if (result[0].name !== "aistudy_opening_e2e") throw new Error("Database identity mismatch");
  } finally { await sql.end(); }
  const redis = new Redis(env.REDIS_URL, { connectTimeout: 5000, maxRetriesPerRequest: 1 });
  try {
    if (await redis.ping() !== "PONG") throw new Error("Redis did not answer PING");
    // This URL is fixed to this task's dedicated Redis process; clear stale queue IDs before DB reset.
    if (env.REDIS_URL !== "redis://127.0.0.1:16379/0") throw new Error("Refusing non-isolated Redis reset");
    await redis.flushdb();
  } finally { redis.disconnect(); }
  await prepareOpeningE2eStorage(env);
  console.log("Isolated PostgreSQL SELECT, Redis PING and S3 byte roundtrip passed.");
}
