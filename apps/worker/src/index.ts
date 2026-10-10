import { Worker } from "bullmq";
import { workerSmokeJobSchema } from "@aistudy/contracts";
import { PLATFORM_NAME, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningMemoryRepository, createOpeningPrivacyRepository, createOpeningSourceRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository, createOpeningLearningRepository, readOpeningCourseEvidence, readLearningPreferences, createOpeningRetestRepository, createOpeningKnowledgeRepository, createOpeningImportChunksRepository,
  createOpeningPlanningSettingsRepository, readLatestStemPromptsBySkill, createSqlClient, OpeningS3, sweepExpiredPendingUploadsAll } from "@aistudy/database";
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
import { createBuildCourseKnowledgeHandler } from "./jobs/build-course-knowledge";
import { createParseMediaHandler } from "./jobs/parse-media";
import { createExtractStudyActionsHandler } from "./jobs/extract-study-actions";
import { createSweepPendingUploadsJob, PENDING_UPLOAD_SWEEP_INTERVAL_MS } from "./jobs/sweep-pending-uploads";
import { createPythonTranscribeAdapter } from "./parsers/transcribe-adapter";
import { PutObjectCommand } from "@aws-sdk/client-s3";
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
  const planningSettings = createOpeningPlanningSettingsRepository(sql);
  const remind = createRemindHandler({
    record: (id, input) => reminders.recordAttempt(id, input),
    isCurrent: (id, at) => reminders.isCurrent(id, at),
    externalConfig: (job) => reminders.getExternalConfig({ workspaceId: job.workspaceId, ownerUserId: job.ownerUserId }),
    // TZ01: live planning TZ for older jobs lacking payload.timeZone stamp.
    resolveTimeZone: async (job) => {
      const preference = await planningSettings.get({
        workspaceId: job.workspaceId,
        ownerUserId: job.ownerUserId,
      });
      return resolveWorkspaceTimeZone(preference.settings?.timeZone);
    },
    send: (input, signal) => feishu.send(input, signal),
  });
  const knowledge = createOpeningKnowledgeRepository(sql);
  const buildCourseKnowledge = createBuildCourseKnowledgeHandler({
    listAuthorizedChunks: (scope, courseId) => knowledge.listAuthorizedChunks(scope, courseId),
    get: (scope, courseId) => knowledge.get(scope, courseId),
    replace: (scope, courseId, input) => knowledge.replace(scope, courseId, input),
    resolveProvider: async (scope) => (await resolveTutorModel(sql, scope, "explain")).provider,
  });
  const parseMedia = createParseMediaHandler({
    sources,
    chunks,
    storage,
    tempDir: env.parserTempDir,
    // Wire faster-whisper when the optional parser extra + offline weights exist;
    // CONFIGURATION / blocked_not_configured otherwise (no auto-download).
    transcribe: createPythonTranscribeAdapter(),
    putObject: async ({ key, body, mime }) => {
      await storage.client.send(
        new PutObjectCommand({
          Bucket: storage.bucket,
          Key: key,
          Body: body,
          ContentType: mime,
        }),
      );
    },
  });
  const importChunks = createOpeningImportChunksRepository(sql);
  const extractStudyActions = createExtractStudyActionsHandler({
    listAuthorizedImportChunks: (scope, courseId, receiptIds) =>
      importChunks.listAuthorizedImportChunks(scope, courseId, receiptIds),
  });
  const handlers = createHandlers(parse, { retest, remind, "build-course-knowledge": buildCourseKnowledge, "parse-media": parseMedia, "extract-study-actions": extractStudyActions });
  const tutorJobs = createOpeningTutorJobsRepository(sql);
  // TZ01: factory timeZone is fallback only; reserve() prefers planning_settings.timeZone
  // and counts completed spend via resolveBudgetLocalDay half-open bounds.
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
  // G4: slower interval for pending-upload TTL sweep (Data sweepExpiredPendingUploadsAll).
  // Returned swept ids are the notify hook — delivery skipped this wave.
  const sweepPendingUploads = createSweepPendingUploadsJob({
    sweepAll: (options) => sweepExpiredPendingUploadsAll(sql, options),
  });
  const sweepTick = setInterval(() => {
    if (stopping) return;
    void sweepPendingUploads().catch(() => {
      /* sweep failure must not crash the worker */
    });
  }, PENDING_UPLOAD_SWEEP_INTERVAL_MS);
  const shutdown = async () => {
    stopping = true;
    clearInterval(tick);
    clearInterval(sweepTick);
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

export { createRetestCloseHandler } from "./jobs/retest-close";

export { createExtractStudyActionsHandler } from "./jobs/extract-study-actions";
