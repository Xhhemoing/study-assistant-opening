/** A timer may request another run, but never overlap an active run. */
export function createSerialTask(task: () => Promise<unknown>, onError: (error: unknown) => void) {
  let stopped = false;
  let active: Promise<void> | undefined;
  return {
    run(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (active) return active;
      active = Promise.resolve().then(task).then(() => undefined, onError).finally(() => { active = undefined; });
      return active;
    },
    async stop(): Promise<void> {
      stopped = true;
      await active;
    },
  };
}

/** Heartbeats stop and drain before the handler releases its DB dependency. */
export async function withJobHeartbeat<T>(heartbeat: () => Promise<unknown>, handler: () => Promise<T>, intervalMs = 30_000): Promise<T> {
  const task = createSerialTask(async () => {
    // A failed CAS means cancellation, a terminal state, or a newer claim.
    // Stop scheduling without retrying or changing the external call outcome.
    if (await heartbeat() === false) clearInterval(timer);
  }, (error) => {
    console.error("job heartbeat failed", error instanceof Error ? error.name : "unknown error");
  });
  const timer = setInterval(() => { void task.run(); }, intervalMs);
  timer.unref();
  try {
    return await handler();
  } finally {
    clearInterval(timer);
    await task.stop();
  }
}
