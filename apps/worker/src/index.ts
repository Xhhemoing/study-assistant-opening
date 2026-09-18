import { Worker } from "bullmq";
import { workerSmokeJobSchema } from "@aistudy/contracts";
import { PLATFORM_NAME } from "@aistudy/domain";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningSourceRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository, createSqlClient, OpeningS3 } from "@aistudy/database";
import { createOpeningProvider } from "@aistudy/ai";
import { createRedisConnection, createQueues } from "./runtime/queue";
import { dispatchPending, dispatchTutorTurns } from "./runtime/dispatch";
import { createHandlers, handlerForKind } from "./runtime/handlers";
import { createNodeRunner } from "./parsers/docling-process";
import { createParseSourceHandler } from "./jobs/parse-source";
import { createTutorTurnHandler } from "./jobs/tutor-turn";
import { runJob } from "./runtime/run-job";

/**
 * In-memory smoke processor. Kept pure so unit tests do not require Redis.
 */
export function processSmokeJob(input: unknown): {
  platform: typeof PLATFORM_NAME;
  echo: string;
} {
  const job = workerSmokeJobSchema.parse(input);
  return {
    platform: PLATFORM_NAME,
    echo: job.message,
  };
}

export async function main(): Promise<void> {
  const redis = createRedisConnection({ url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" });
  const sql = createSqlClient(process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/aistudy");
  const repository = createOpeningJobRepository(sql);
  const sources = createOpeningSourceRepository(sql);
  const chunks = createOpeningSourceChunksRepository(sql);
  const storage = new OpeningS3({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: process.env.S3_REGION ?? "us-east-1", bucket: process.env.S3_BUCKET ?? "aistudy", accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin", forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false" });
  const parse = createParseSourceHandler({ sources, chunks, storage, runner: createNodeRunner(), tempDir: process.env.PARSER_TEMP_DIR ?? ".tmp/opening-parser" });
  const handlers = createHandlers(parse);
  const tutorJobs = createOpeningTutorJobsRepository(sql);
  const budget = createOpeningBudgetRepository(sql);
  const openingModel = {
    baseUrl: process.env.OPENING_MODEL_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENING_MODEL_API_KEY ?? "",
    model: process.env.OPENING_MODEL_NAME ?? "gpt-4o-mini",
  };
  const tutorTurn = createTutorTurnHandler({
    tutorJobs,
    chunks,
    budget,
    provider: openingModel.apiKey
      ? createOpeningProvider({ baseUrl: openingModel.baseUrl, apiKey: openingModel.apiKey, model: openingModel.model })
      : null,
    config: {
      maxContextCharacters: Number(process.env.OPENING_TUTOR_MAX_CONTEXT_CHARS ?? 12_000),
      reservedCents: Number(process.env.OPENING_TUTOR_RESERVED_CENTS ?? 100),
      maxOutputTokens: Number(process.env.OPENING_TUTOR_MAX_OUTPUT_TOKENS ?? 2_048),
      inputCentsPerMillion: Number(process.env.OPENING_MODEL_INPUT_CENTS_PER_MILLION ?? 0),
      outputCentsPerMillion: Number(process.env.OPENING_MODEL_OUTPUT_CENTS_PER_MILLION ?? 0),
    },
  });
  const queues = createQueues(redis);
  let stopping = false;
  const workers = Object.entries(queues).map(([kind, queue]) => new Worker(queue.name, async (job) => {
    if (stopping) return;
    if (kind === "tutor") {
      const data = job.data as { jobId?: string };
      if (!data.jobId) throw new Error("tutor queue job is missing its tutor job id");
      await tutorTurn(data.jobId);
      return;
    }
    await runJob(repository, job.data.jobId ?? job.id, handlerForKind(kind, handlers));
  }, { connection: redis, concurrency: kind === "parse" ? 1 : 2 }));
  const tick = setInterval(() => { void dispatchPending({ repository, queues }).then(() => dispatchTutorTurns({ tutorJobs, queues })); }, 1000);
  const shutdown = async () => {
    stopping = true;
    clearInterval(tick);
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(Object.values(queues).map((queue) => queue.close()));
    await redis.quit();
    await sql.end({ timeout: 5 });
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  await dispatchPending({ repository, queues });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("index.ts") || entry.endsWith("index.js")) void main();
