import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@aistudy/database";
import * as guard from "../chambers/chamber-guard";
import { main } from "../index";
import { OPENING_QUEUE_KINDS } from "./queue";

const runtime = vi.hoisted(() => ({
  subscriptions: vi.fn(), publish: vi.fn(), readiness: vi.fn(), sqlEnd: vi.fn(),
  redis: () => ({ on: vi.fn(), disconnect: vi.fn() }),
}));

vi.mock("bullmq", async original => ({
  ...await original<typeof import("bullmq")>(),
  Worker: class {
    constructor(name: string, _process: unknown, readonly opts: { name: string }) { runtime.subscriptions(name); }
    on() {}
    async close() {}
    async pause() {}
  },
}));

vi.mock("./queue", async original => {
  const actual = await original<typeof import("./queue")>();
  return { ...actual, createRedisConnection: runtime.redis, createProducerRedisConnection: runtime.redis,
    createQueue: (kind: string) => ({ name: kind }),
    createQueues: () => Object.fromEntries(actual.OPENING_QUEUE_KINDS.map(kind => [kind, { name: kind }])),
  };
});

vi.mock("./worker-readiness", () => ({
  createWorkerReadiness: (file: string, identity: unknown) => {
    runtime.readiness(file, identity);
    return { publish: runtime.publish, invalidate: vi.fn(), degrade: vi.fn() };
  },
  assertConsumersActive: vi.fn(), consumersReady: vi.fn(async () => true),
}));

vi.mock("@aistudy/database", async original => {
  const actual = await original<typeof import("@aistudy/database")>();
  return { ...actual,
    createSqlClient: vi.fn(() => ({ end: runtime.sqlEnd })),
    createOpeningJobRepository: () => ({ recoverExpired: vi.fn(), dispatchPending: vi.fn() }),
    createOpeningTutorJobsRepository: vi.fn(() => ({
      recoverExpired: vi.fn(), listQueued: async () => [], expireStale: vi.fn(),
    })),
    createOpeningExplicitRegradeRequestRepository: vi.fn(() => ({ recoverConfirmed: vi.fn() })),
    createOpeningAiGradingJobRepository: vi.fn(() => ({ recoverExpired: vi.fn() })),
    createOpeningAiGradingRepository: vi.fn(actual.createOpeningAiGradingRepository),
    createOpeningTeachingContentRepository: vi.fn(actual.createOpeningTeachingContentRepository),
    createOpeningEphemeralProvenanceRepository: vi.fn(() => ({ purgeExpiredQueries: vi.fn() })),
    reconcileStaleTeachingGenerations: vi.fn(), sweepExpiredPendingUploadsAll: vi.fn(async () => []),
  };
});

vi.mock("../chambers/chamber-guard", { spy: true });

const logisticsKinds = ["remind", "build-course-knowledge", "extract-study-actions", "index-source"];
const teachingKinds = ["tutor", "tutor-metadata", "retest", "compile-teaching-unit", "recognize-photo-question", "grade-observation"];

describe("worker main chamber startup and scheduled recovery", () => {
  let originalListeners: Record<"SIGTERM" | "SIGINT", Set<NodeJS.SignalsListener>>;
  const startingExitCode = process.exitCode;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    originalListeners = { SIGTERM: new Set(process.listeners("SIGTERM")), SIGINT: new Set(process.listeners("SIGINT")) };
    vi.stubEnv("DATABASE_URL", "postgres://localhost/unit");
    vi.stubEnv("REDIS_URL", "redis://localhost");
    vi.stubEnv("PARSER_PYTHON", "/missing/parser/python");
    vi.stubEnv("PARSER_CWD", "/missing/parser");
  });
  afterEach(() => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!originalListeners[signal].has(listener)) process.removeListener(signal, listener);
      }
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    process.exitCode = startingExitCode;
  });

  it.each(["logistics", "teaching", "tutor", "learning"])("starts %s with only its assigned handlers and queues", async role => {
    vi.stubEnv("WORKER_ROLE", role);
    await main();
    const learning = role === "learning", logistics = role === "logistics";
    const expected = learning ? OPENING_QUEUE_KINDS.filter(kind => !["parse", "parse-media"].includes(kind))
      : logistics ? logisticsKinds : teachingKinds;
    expect(runtime.subscriptions.mock.calls.map(([kind]) => kind).sort()).toEqual([...expected].sort());
    expect(runtime.readiness).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      role: role === "tutor" ? "teaching" : role, queueKinds: OPENING_QUEUE_KINDS.filter(kind => expected.includes(kind)),
    }));
    expect(runtime.publish).toHaveBeenCalledOnce();
    expect(db.createSqlClient).toHaveBeenCalledTimes(1);
    expect(guard.createLogisticsChamberDeps).toHaveBeenCalledTimes(learning || logistics ? 1 : 0);
    expect(db.createOpeningAiGradingRepository).toHaveBeenCalledTimes(logistics ? 0 : 1);
    expect(db.createOpeningTeachingContentRepository).toHaveBeenCalledTimes(logistics ? 0 : 1);
    expect(db.createOpeningTutorJobsRepository).toHaveBeenCalledTimes(logistics ? 0 : 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Boolean(vi.mocked(db.createOpeningExplicitRegradeRequestRepository).mock.calls.length)).toBe(!logistics);
    expect(Boolean(vi.mocked(db.createOpeningAiGradingJobRepository).mock.calls.length)).toBe(!logistics);
    expect(db.reconcileStaleTeachingGenerations).toHaveBeenCalledTimes(logistics ? 0 : 1);
    expect(db.sweepExpiredPendingUploadsAll).toHaveBeenCalledTimes(learning || logistics ? 1 : 0);
  });
});
