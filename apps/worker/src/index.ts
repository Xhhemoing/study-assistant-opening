import type { WorkerSmokeJob } from "@aistudy/contracts";
import { workerSmokeJobSchema } from "@aistudy/contracts";
import { PLATFORM_NAME } from "@aistudy/domain";

/**
 * In-memory smoke processor. Real BullMQ wiring lands after infra (Task 3).
 * Kept pure so unit tests do not require Redis.
 */
export function processSmokeJob(input: unknown): {
  platform: typeof PLATFORM_NAME;
  echo: string;
} {
  const job: WorkerSmokeJob = workerSmokeJobSchema.parse(input);
  return {
    platform: PLATFORM_NAME,
    echo: job.message,
  };
}

export function main(): void {
  const result = processSmokeJob({ kind: "smoke", message: "worker-ready" });
  console.log(JSON.stringify({ status: "ok", ...result }));
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("index.ts") || entry.endsWith("index.js")) {
  main();
}
