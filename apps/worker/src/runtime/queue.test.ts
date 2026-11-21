import { describe, expect, it, vi } from "vitest";
import IORedis from "ioredis";
import { openingRedisConnectionOptions } from "@aistudy/database";

vi.mock("bullmq", () => ({
  Queue: class MockQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  },
}));

import { createQueues } from "./queue";

describe("createQueues", () => {
  it("includes extract-study-actions so outbox jobs of that kind are consumed", () => {
    const queues = createQueues({} as never);
    expect(Object.keys(queues).sort()).toEqual([
      "build-course-knowledge",
      "compile-teaching-unit",
      "extract-study-actions",
      "grade-observation",
      "index-source",
      "parse",
      "parse-media",
      "recognize-photo-question",
      "remind",
      "retest",
      "tutor",
      "tutor-metadata",
    ]);
    expect(queues["extract-study-actions"].name).toBe("opening-extract-study-actions");
  });

  it("includes compile-teaching-unit for V2-07 teaching generation", () => {
    const queues = createQueues({} as never);
    expect(queues["compile-teaching-unit"].name).toBe("opening-compile-teaching-unit");
  });
});

it.each([
  "redis://127.0.0.1?port=6380&db=3&family=6",
  "rediss://[::1]:6380/2?family=6",
  "redis://?path=%2Ftmp%2Fred.sock",
  "redis://?tls=true&username=query-user&password=query-pass",
])("matches ioredis 5.6.1 endpoint resolution for %s", url => {
  const redis = new IORedis(url, { lazyConnect: true });
  const expected = openingRedisConnectionOptions(url);
  expect(redis.options.host).toBe(expected.host);
  expect(redis.options.port).toBe(expected.port);
  expect(redis.options.family).toBe(expected.family);
  expect(redis.options.db).toBe(expected.db);
  expect(redis.options.path).toBe(expected.path);
  expect(redis.options.username ?? undefined).toBe(expected.username);
  expect(redis.options.password ?? undefined).toBe(expected.password);
  expect(Boolean(redis.options.tls)).toBe(Boolean(expected.tls));
  redis.disconnect();
});
