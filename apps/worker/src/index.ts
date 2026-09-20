import { Worker } from "bullmq";
import { workerSmokeJobSchema } from "@aistudy/contracts";
import { PLATFORM_NAME } from "@aistudy/domain";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningPrivacyRepository, createOpeningSourceRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository, createOpeningLearningRepository, createOpeningRetestRepository, createSqlClient, OpeningS3 } from "@aistudy/database";
import { createOpeningProvider } from "@aistudy/ai";
import { loadOpeningModel, loadOpeningTutorConfig } from "@aistudy/config";
import { createRedisConnection, createQueues } from "./runtime/queue";
import { dispatchPending, dispatchTutorTurns } from "./runtime/dispatch";
import { createHandlers, handlerForKind } from "./runtime/handlers";
import { createNodeRunner } from "./parsers/docling-process";
import { createParseSourceHandler } from "./jobs/parse-source";
import { createTutorTurnHandler } from "./jobs/tutor-turn";
import { createRetestCandidateHandler } from "./jobs/retest-candidate";
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
  const openingModel = loadOpeningModel();
  const redis = createRedisConnection({ url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" });
  const sql = createSqlClient(process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/aistudy");
  const repository = createOpeningJobRepository(sql);
  const privacyRepo = createOpeningPrivacyRepository(sql);
  const learningDb = {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
    async execute(text: string, params: unknown[] = []): Promise<void> {
      await sql.unsafe(text, params as never[]);
    },
  };
  const learning = createOpeningLearningRepository(learningDb);
  const retests = createOpeningRetestRepository(sql);
  const sources = createOpeningSourceRepository(sql);
  const chunks = createOpeningSourceChunksRepository(sql);
  const storage = new OpeningS3({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: process.env.S3_REGION ?? "us-east-1", bucket: process.env.S3_BUCKET ?? "aistudy", accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin", forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false" });
  const parse = createParseSourceHandler({ sources, chunks, storage, runner: createNodeRunner(), tempDir: process.env.PARSER_TEMP_DIR ?? ".tmp/opening-parser" });
  const retest = createRetestCandidateHandler({
    listObservations: (scope, courseId) => learning.listObservationsForCourse(scope, courseId),
    listDueRetestSkills: (scope, courseId) => retests.listAcceptedSkillLabels(scope, courseId),
    saveCandidates: (scope, candidates) => retests.saveCandidates(scope, candidates),
  });
  const handlers = createHandlers(parse, { retest });
  const tutorJobs = createOpeningTutorJobsRepository(sql);
  const budget = createOpeningBudgetRepository(sql, { dailyCapCents: openingModel.dailyCapCents });
  const tutorTurn = createTutorTurnHandler({
    tutorJobs,
    chunks,
    budget,
    provider: openingModel.apiKey && openingModel.dailyCapCents > 0
      ? createOpeningProvider({ baseUrl: openingModel.baseUrl, apiKey: openingModel.apiKey, model: openingModel.name })
      : null,
    config: {
      ...loadOpeningTutorConfig(),
      inputCentsPerMillion: openingModel.inputCentsPerMillion,
      outputCentsPerMillion: openingModel.outputCentsPerMillion,
    },
    privacy: {
      getWorkspaceEpoch: (scope) => privacyRepo.getWorkspaceEpoch(scope),
      listExcludedSourceIds: (scope) => privacyRepo.listExcludedSourceIds(scope),
    },
    learning: {
      insertHelpExposure: (scope, exposure) => learning.insertHelpExposure(scope, exposure),
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
