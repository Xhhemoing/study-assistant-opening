import { Worker } from "bullmq";
import { workerSmokeJobSchema } from "@aistudy/contracts";
import { PLATFORM_NAME } from "@aistudy/domain";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningMemoryRepository, createOpeningPrivacyRepository, createOpeningSourceRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository, createOpeningLearningRepository, readOpeningCourseEvidence, readLearningPreferences, createOpeningRetestRepository,
  readLatestStemPromptsBySkill, createSqlClient, OpeningS3 } from "@aistudy/database";
import { resolveTutorModel } from "./runtime/tutor-model";
import { createSourcePageImages } from "./runtime/source-page-images";
import { loadOpeningModelCatalog, loadOpeningTutorConfig, loadWorkerEnv } from "@aistudy/config";
import { createRedisConnection, createQueues } from "./runtime/queue";
import { dispatchPending, dispatchTutorTurns } from "./runtime/dispatch";
import { createHandlers, handlerForKind } from "./runtime/handlers";
import { preflightParser } from "./parsers/parser-preflight";
import { createParseSourceHandler } from "./jobs/parse-source";
import { createTutorTurnHandler } from "./jobs/tutor-turn";
import { createRetestCandidateHandler } from "./jobs/retest-candidate";
import { createRemindHandler } from "./jobs/remind";
import { createFeishuReminderAdapter } from "./channels/feishu-reminder";
import { createOpeningReminderRepository } from "@aistudy/database";
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
  const env = loadWorkerEnv();
  const runner = await preflightParser();
  const openingModel = loadOpeningModelCatalog();
  const redis = createRedisConnection({ url: env.redisUrl });
  const sql = createSqlClient(env.databaseUrl);
  const repository = createOpeningJobRepository(sql);
  const privacyRepo = createOpeningPrivacyRepository(sql);
  const learning = createOpeningLearningRepository(sql);
  const retests = createOpeningRetestRepository(sql);
  const sources = createOpeningSourceRepository(sql);
  const chunks = createOpeningSourceChunksRepository(sql);
  const storage = new OpeningS3(env.s3);
  const parse = createParseSourceHandler({ sources, chunks, storage, runner, tempDir: env.parserTempDir });
  const retest = createRetestCandidateHandler({
    readLearningPreferences: (scope, courseId) => readLearningPreferences(sql, scope, courseId),
    readCourseEvidence: (scope, courseId) => readOpeningCourseEvidence(sql, scope, courseId),
    listDueRetests: (scope, courseId) => retests.listDueEvidence(scope, courseId),
    saveCandidates: (scope, candidates, epoch, jobId) => retests.saveCandidates(scope, candidates, epoch, jobId),
    readStemPromptsBySkill: (scope, courseId) => readLatestStemPromptsBySkill(sql, scope, courseId),
  });
  const reminders = createOpeningReminderRepository(sql);
  const feishu = createFeishuReminderAdapter({ credential: process.env.FEISHU_REMINDER_CREDENTIAL ?? null });
  const remind = createRemindHandler({
    record: (id, input) => reminders.recordAttempt(id, input),
    isCurrent: (id, at) => reminders.isCurrent(id, at),
    externalConfig: (job) => reminders.getExternalConfig({ workspaceId: job.workspaceId, ownerUserId: job.ownerUserId }),
    send: (input, signal) => feishu.send(input, signal),
  });
  const handlers = createHandlers(parse, { retest, remind });
  const tutorJobs = createOpeningTutorJobsRepository(sql);
  const budget = createOpeningBudgetRepository(sql, { envCapCents: openingModel.dailyCapCents, pricingConfigured: openingModel.models.some(m => m.inputCentsPerMillion > 0 && m.outputCentsPerMillion > 0) });
  const memory = createOpeningMemoryRepository(sql);
  const tutorTurn = createTutorTurnHandler({
    tutorJobs,
    chunks,
    budget,
    provider: null,
    resolveModel: (scope, mode) => resolveTutorModel(sql, scope, mode),
    pageImages: createSourcePageImages(sql, storage),
    config: {
      ...loadOpeningTutorConfig(),
      inputCentsPerMillion: 0,
      outputCentsPerMillion: 0,
    },
    privacy: {
      getWorkspaceEpoch: (scope) => privacyRepo.getWorkspaceEpoch(scope),
      listExcludedSourceIds: (scope) => privacyRepo.listExcludedSourceIds(scope),
    },
    memories: {
      listContext: (scope, now) => memory.listContext(scope, now),
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
