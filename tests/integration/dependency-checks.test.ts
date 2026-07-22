import { createServer } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkDatabase,
  checkRedis,
  checkStorage,
} from "../../apps/web/src/server/dependency-checks";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("live dependency probes", () => {
  const fakeS3 = createServer((req, res) => {
    // MinIO/S3 HeadBucket-style success for any path.
    if (req.method === "HEAD" || req.method === "GET") {
      res.statusCode = 200;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  });

  let baseUrl = "";

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      fakeS3.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("reports database and redis up against local services", async () => {
    await new Promise<void>((resolve) => {
      fakeS3.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fakeS3.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind fake S3");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const database = await checkDatabase(databaseUrl);
    const redis = await checkRedis(redisUrl);
    const storage = await checkStorage({
      endpoint: baseUrl,
      region: "us-east-1",
      bucket: "aistudy",
      accessKeyId: "test",
      secretAccessKey: "test",
      forcePathStyle: true,
    });

    expect(database.status).toBe("up");
    expect(redis.status).toBe("up");
    expect(storage.status).toBe("up");
    expect(database.latencyMs).toBeTypeOf("number");
  });
});
