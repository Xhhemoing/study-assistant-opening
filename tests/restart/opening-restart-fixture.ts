import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { Queue } from "bullmq";
import IORedis from "ioredis";

export function assertOpeningRestartEnvironment(env: NodeJS.ProcessEnv) {
  const database = new URL(env.E2E_DATABASE_URL ?? "invalid:");
  if (env.OPENING_E2E !== "1" || env.DATABASE_URL !== env.E2E_DATABASE_URL
    || !["postgres:", "postgresql:"].includes(database.protocol) || database.hostname !== "127.0.0.1"
    || database.port !== "15432" || database.pathname !== "/aistudy_opening_e2e" || database.search || database.hash
    || env.REDIS_URL !== "redis://127.0.0.1:16379/0" || env.S3_ENDPOINT !== "http://127.0.0.1:19000"
    || env.S3_BUCKET !== "opening-e2e" || env.PUBLIC_BASE_URL !== "http://127.0.0.1:3100") {
    throw new Error("Restart acceptance requires the unchanged dedicated Opening E2E services");
  }
}

export async function readOpeningRestartBuild(root: string) {
  const directory = path.join(root, "apps/web/.next-opening-e2e");
  const [rawId, rawManifest] = await Promise.all([readFile(path.join(directory, "BUILD_ID"), "utf8"), readFile(path.join(directory, "required-server-files.json"), "utf8")]);
  const manifest = JSON.parse(rawManifest) as { config?: { distDir?: string } };
  const buildId = rawId.trim();
  if (!buildId || manifest.config?.distDir !== ".next-opening-e2e") throw new Error("Restart acceptance needs the existing Opening E2E production build");
  return buildId;
}

const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
type Exit = { service: "web" | "worker"; pid: number; code: number | null; signal: NodeJS.Signals | null; graceful: boolean };
type Owned = { service: Exit["service"]; child: ChildProcess; exited: Promise<Exit>; result?: Exit; expected: boolean; error?: Error; log: string };
export type RestartCycle = { cycle: number; webPid: number; workerPid: number; workerClientIds: string[]; buildId: string };

/** Owns only direct children created here; never discovers or kills other PIDs. */
export function createOpeningRestartServices(input: NodeJS.ProcessEnv, root = process.cwd()) {
  const env = { ...input };
  assertOpeningRestartEnvironment(env);
  let connection: IORedis | undefined, queue: Queue | undefined;
  let buildId = "", cycle = 0;
  let current: Owned[] = [];
  const processes: Owned[] = [], events: unknown[] = [];
  function live(item: Owned) {
    if (item.error) throw item.error;
    if (item.result) throw new Error(`${item.service} exited before the requested restart (${item.result.code ?? item.result.signal})`);
  }
  async function registrations() {
    if (!connection) {
      connection = new IORedis(env.REDIS_URL!, { maxRetriesPerRequest: 1, connectTimeout: 5000, commandTimeout: 5000 });
      queue = new Queue("opening-retest", { connection });
      connection.on("error", error => events.push({ event: "redis-error", message: error.message }));
      queue.on("error", error => events.push({ event: "queue-error", message: error.message }));
    }
    return (await queue!.getWorkers()).map(worker => String(worker.id)).sort();
  }
  async function assertIdle() {
    buildId = await readOpeningRestartBuild(root);
    const deadline = Date.now() + 15_000;
    while ((await registrations()).length) {
      if (Date.now() >= deadline) throw new Error("Another retest worker is registered; refusing to touch an unowned process");
      await delay(200);
    }
    for (const port of [3100, 18081]) {
      while (true) {
        const available = await new Promise<boolean>((resolve, reject) => {
          const probe = createServer();
          probe.once("error", error => (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? resolve(false) : reject(error));
          probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve(true)));
        });
        if (available) break;
        if (Date.now() >= deadline) throw new Error(`Port ${port} remains occupied; refusing to touch an unowned server`);
        await delay(200);
      }
    }
  }
  function launch(service: Exit["service"], args: string[], cwd: string): Owned {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const item = { service, child, expected: false, log: "" } as Owned;
    const append = (chunk: Buffer) => { item.log = (item.log + chunk.toString()).slice(-128_000); };
    child.stdout!.on("data", append); child.stderr!.on("data", append);
    item.exited = new Promise(resolve => {
      child.once("error", error => { item.error = error; resolve(item.result = { service, pid: child.pid ?? -1, code: null, signal: null, graceful: false }); });
      child.once("exit", (code, signal) => {
        // The worker's shutdown hook drains its work and closes queues/SQL. A
        // default SIGTERM death must not pass as evidence that the hook ran.
        const cleanExit = code === 0 && signal === null;
        const result = { service, pid: child.pid ?? -1, code, signal,
          graceful: item.expected && (cleanExit || (service === "web" && signal === "SIGTERM")) };
        item.result = result; events.push({ event: "exit", cycle, ...result }); resolve(result);
      });
    });
    processes.push(item); events.push({ event: "spawn", cycle, service, pid: child.pid });
    return item;
  }
  async function start(): Promise<RestartCycle> {
    if (current.length) throw new Error("Stop the owned services before starting the next cycle");
    await assertIdle(); cycle++;
    current = [launch("web", [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3100"], path.join(root, "apps/web")),
      launch("worker", ["--import", "tsx", "apps/worker/src/index.ts"], root)];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      current.forEach(live);
      const workerClientIds = await registrations();
      let healthy = false;
      try {
        const response = await fetch(`${env.PUBLIC_BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
        healthy = response.status === 200 && (await response.json() as { status?: string }).status === "ok";
      } catch { /* The owned web process may still be opening its port. */ }
      current.forEach(live);
      if (healthy && workerClientIds.length) {
        const ready = { cycle, webPid: current[0]!.child.pid!, workerPid: current[1]!.child.pid!, workerClientIds, buildId };
        events.push({ event: "ready", ...ready }); return ready;
      }
      await delay(250);
    }
    throw new Error("Owned web health and real BullMQ worker registration did not become ready");
  }
  async function stopOwned(item: Owned): Promise<Exit> {
    live(item); item.expected = true;
    if (!item.child.kill("SIGTERM")) throw new Error(`Could not send SIGTERM to owned ${item.service}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await Promise.race([item.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned ${item.service} did not exit gracefully within 30 seconds`)), 30_000);
      })]);
      if (!exit.graceful) throw new Error(`Owned ${item.service} failed during shutdown`);
      return exit;
    } finally { clearTimeout(timer); }
  }
  async function stop() {
    const results = await Promise.allSettled(current.map(stopOwned));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Graceful restart failed; forced cleanup cannot count as success");
    current = [];
    return results.map(result => (result as PromiseFulfilledResult<Exit>).value);
  }
  async function dispose() {
    const remaining = processes.filter(item => !item.result);
    const results = await Promise.allSettled(remaining.map(stopOwned));
    try {
      for (const item of remaining) if (!item.result) {
        item.child.kill("SIGKILL");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([item.exited, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Owned ${item.service} did not exit after forced cleanup`)), 5000);
          })]);
        } finally { clearTimeout(timer); }
      }
    } finally { try { await queue?.close(); } finally { connection?.disconnect(); } }
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Service cleanup required a forced stop");
  }
  return { assertIdle, start, stop, dispose,
    diagnostics: () => ({ kind: "same-version-graceful-restart", events, processes: processes.map(item => ({ service: item.service, pid: item.child.pid, exit: item.result, log: item.log })) }) };
}
