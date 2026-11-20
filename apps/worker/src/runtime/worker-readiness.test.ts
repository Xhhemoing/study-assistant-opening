import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertConsumersActive, consumersReady, createWorkerReadiness } from "./worker-readiness";
import { loadWorkerEnv } from "@aistudy/config";
import { verifyWorkerReadiness } from "../../../../infra/deploy/hermes-health.mjs";
import { prepareWorkerRole } from "./worker-role";
import { runStartupWithBackoff } from "./startup-backoff";

afterEach(() => { vi.useRealTimers(); });
it("degrades paused consumers without throwing and becomes ready again on resume", async () => {
  let paused = true;
  const consumer = { name: "parse", waitUntilReady: async () => {}, isRunning: () => true,
    isPaused: () => paused, getWorkers: async () => [{ rawname: "bull:queue:w:parse" }] };
  expect(await consumersReady([consumer], 100)).toBe(false);
  paused = false; expect(await consumersReady([consumer], 100)).toBe(true);
  consumer.waitUntilReady = async () => { paused = true; };
  expect(await consumersReady([consumer], 100)).toBe(false);
});
it("awaits readiness and verifies this named consumer, not a different live worker", async () => {
  vi.useFakeTimers();
  const consumer = { name: "pid-unique-parse", waitUntilReady: vi.fn(async () => {}),
    isRunning: () => true, isPaused: () => false, getWorkers: vi.fn(async () => [{ rawname: "bull:queue:w:other-pid" }]) };
  const checking = assertConsumersActive([consumer], 100);
  const rejected = expect(checking).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(100); await rejected;
  consumer.getWorkers.mockResolvedValue([{ rawname: "bull:queue:w:pid-unique-parse" }]);
  await assertConsumersActive([consumer], 100);
  expect(consumer.waitUntilReady).toHaveBeenCalledTimes(2);
  await expect(assertConsumersActive([{ ...consumer, isPaused: () => true }], 100)).rejects.toThrow("not running");
});
it("atomically publishes a bounded PID/release/role/full queues receipt and invalidates irreversibly", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-ready-"));
  const file = path.join(directory, "ready.json");
  try {
    const ready = createWorkerReadiness(file, { release: "/release", role: "parser", queueKinds: ["parse-media", "parse"] });
    ready.publish();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, release: "/release", role: "parser", queueKinds: ["parse", "parse-media"] });
    ready.degrade(); expect(() => readFileSync(file)).toThrow();
    ready.publish(); expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ role: "parser" });
    ready.invalidate(); expect(() => readFileSync(file)).toThrow(); expect(() => ready.publish()).toThrow("invalidated");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it("retries startup in-process with exponential bounded delays and no failure cache", async () => {
  const start = vi.fn().mockRejectedValueOnce(new Error("one")).mockRejectedValueOnce(new Error("two"))
    .mockRejectedValueOnce(new Error("three")).mockResolvedValue(undefined);
  const sleep = vi.fn(async (_ms: number) => {});
  await runStartupWithBackoff(start, { initialMs: 1000, maxMs: 2000 }, { sleep, report: vi.fn() });
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 2000]);
  expect(start).toHaveBeenCalledTimes(4);
});

it.each(["all", "learning", "parser", "logistics", "teaching", "tutor"])(
  "Hermes verifies the receipt published for WORKER_ROLE=%s", async role => {
    const configured = { WORKER_ROLE: role };
    const { workerRole } = loadWorkerEnv(configured);
    const { queueKinds } = await prepareWorkerRole(workerRole, async () => async () => ({ exitCode: 0, stdout: "" }), {
      probe: async () => ({ status: "not_configured", directoryConfigured: false, directoryExists: false,
        missingFiles: [], inferenceMs: null }),
    });
    const directory = mkdtempSync(path.join(tmpdir(), "hermes-worker-ready-"));
    const file = path.join(directory, "ready.json");
    try {
      createWorkerReadiness(file, { release: directory, role: workerRole, queueKinds: [...queueKinds] }).publish();
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      const snapshot = { pid: process.pid, consumerPid: process.pid, consumerCwd: directory,
        consumerArgumentPaths: [`${directory}/apps/worker/src/index.ts`], environment: configured };
      const verify = (patch = {}, environment = configured) => verifyWorkerReadiness(
        { ...receipt, ...patch }, { ...snapshot, environment }, directory, configured, receipt.checkedAt,
      );
      expect(receipt.role).toBe(role === "tutor" ? "teaching" : role);
      expect(() => verify()).not.toThrow();
      expect(() => verify({ role: workerRole === "teaching" ? "tutor" : "teaching" })).toThrow(/not ready/);
      expect(() => verify({ queueKinds: receipt.queueKinds.slice(1) })).toThrow(/not ready/);
      expect(() => verify({ queueKinds: [...receipt.queueKinds, receipt.queueKinds[0]] })).toThrow(/not ready/);
      expect(() => verify({}, { WORKER_ROLE: role === "teaching" ? "tutor" : "teaching" })).toThrow(/not ready/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

it("samples Date.now() once per publish so clock ticks cannot exceed 15,000 ms receipt lifetime", async () => {
  const configured = { WORKER_ROLE: "tutor" };
  const { workerRole } = loadWorkerEnv(configured);
  const { queueKinds } = await prepareWorkerRole(workerRole, async () => async () => ({ exitCode: 0, stdout: "" }), {
    probe: async () => ({
      status: "not_configured",
      directoryConfigured: false,
      directoryExists: false,
      missingFiles: [],
      inferenceMs: null,
    }),
  });
  const directory = mkdtempSync(path.join(tmpdir(), "worker-ready-clock-"));
  const file = path.join(directory, "ready.json");
  let tick = 1_700_000_000_000;
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
    tick += 1;
    return tick;
  });
  try {
    createWorkerReadiness(file, { release: directory, role: workerRole, queueKinds: [...queueKinds] }).publish();
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    expect(receipt.expiresAt - receipt.checkedAt).toBe(15_000);
    const snapshot = {
      pid: process.pid,
      consumerPid: process.pid,
      consumerCwd: directory,
      consumerArgumentPaths: [`${directory}/apps/worker/src/index.ts`],
      environment: configured,
    };
    expect(() => verifyWorkerReadiness(receipt, snapshot, directory, configured, receipt.checkedAt)).not.toThrow();
  } finally {
    nowSpy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
