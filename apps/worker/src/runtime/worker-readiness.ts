import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ReadyConsumer = {
  waitUntilReady(): Promise<unknown>;
  isRunning(): boolean;
  isPaused(): boolean;
  getWorkers(): Promise<Array<{ rawname?: string }>>;
  name: string;
};

/** waitUntilReady alone proves a connection, not a live blocking consumer. */
export async function assertConsumersActive(consumers: ReadyConsumer[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  try {
    await Promise.race([
      Promise.all(consumers.map(async worker => {
        await worker.waitUntilReady();
        // BullMQ registers its blocking client asynchronously after ready.
        while (true) {
          if (cancelled) return;
          if (!worker.isRunning() || worker.isPaused()) throw new Error("Worker consumer is not running");
          if ((await worker.getWorkers()).some(client => client.rawname?.endsWith(`:w:${worker.name}`))) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Worker consumers readiness timed out")), timeoutMs); }),
    ]);
  } finally { cancelled = true; clearTimeout(timer); }
}

/** Paused consumers degrade readiness; they are not a process lifecycle fault. */
export async function consumersReady(consumers: ReadyConsumer[], timeoutMs: number): Promise<boolean> {
  if (consumers.some(consumer => consumer.isPaused())) return false;
  try { await assertConsumersActive(consumers, timeoutMs); }
  catch (error) {
    if (consumers.some(consumer => consumer.isPaused())) return false;
    throw error;
  }
  return !consumers.some(consumer => consumer.isPaused());
}

/** Short-lived atomic receipt. A crash/suspended process cannot leave permanent readiness. */
export function createWorkerReadiness(file: string, identity: { role: string; queueKinds: string[]; release: string }) {
  const target = path.resolve(file);
  let invalid = false;
  const invalidate = () => { invalid = true; rmSync(target, { force: true }); };
  rmSync(target, { force: true });
  return {
    invalidate,
    // Recoverable parser degradation removes readiness without retiring the process.
    degrade() { rmSync(target, { force: true }); },
    publish() {
      if (invalid) throw new Error("Worker readiness invalidated");
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(temporary, JSON.stringify({ version: 1, pid: process.pid, supervisorPid: process.ppid,
          ...identity, queueKinds: [...identity.queueKinds].sort(), checkedAt: Date.now(), expiresAt: Date.now() + 15_000 }), { mode: 0o644 });
        renameSync(temporary, target);
      } finally { rmSync(temporary, { force: true }); }
    },
  };
}
