import { loadEnv } from "@aistudy/config";
import { buildHealthResponse } from "../../../server/health";
import {
  checkDatabase,
  checkRedis,
  checkStorage,
} from "../../../server/dependency-checks";

export async function GET(): Promise<Response> {
  let env;
  try {
    env = loadEnv(process.env);
  } catch {
    const body = buildHealthResponse({
      service: "aistudy-web",
      checks: {
        database: { status: "down", errorCode: "config" },
        redis: { status: "down", errorCode: "config" },
        storage: { status: "down", errorCode: "config" },
      },
    });
    return Response.json(body, { status: 503 });
  }

  const [database, redis, storage] = await Promise.all([
    checkDatabase(env.databaseUrl),
    checkRedis(env.redisUrl),
    checkStorage(env.s3),
  ]);

  const body = buildHealthResponse({
    service: "aistudy-web",
    checks: { database, redis, storage },
  });

  const httpStatus = body.status === "ok" ? 200 : 503;
  return Response.json(body, { status: httpStatus });
}
