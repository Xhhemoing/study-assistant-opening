import { Worker } from "bullmq";
import { workerSmokeJobSchema } from "@aistudy/contracts";
import { PLATFORM_NAME, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningMemoryRepository, createOpeningPrivacyRepository, createOpeningSourceRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository, createOpeningLearningRepository, readOpeningCourseEvidence, readLearningPreferences, createOpeningRetestRepository, createOpeningKnowledgeRepository, createOpeningImportChunksRepository,
  createOpeningPlanningSettingsRepository, readLatestStemPromptsBySkill, createSqlClient, OpeningS3, sweepExpiredPendingUploadsAll, readOpeningConversationPlanningContext } from "@aistudy/database";
import { createDbModelGateway, resolveTutorFallbackModel, resolveTutorModel, scopeBudget } from "./runtime/model-gateway";
import { createSourcePageImages } from "./runtime/source-page-images";
import { loadFeatureSwitches, loadOpeningModelCatalog, loadOpeningTutorConfig, loadOpeningUploadQuota, loadServerConfig } from "@aistudy/config";
import { createRedisConnection, createProducerRedisConnection, createQueues } from "./runtime/queue";
import { createSerialTask } from "./runtime/lifecycle";
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
import { createCompileTeachingUnitHandler } from "./jobs/compile-teaching-unit";
import { createSweepPendingUploadsJob, PENDING_UPLOAD_SWEEP_INTERVAL_MS } from "./jobs/sweep-pending-uploads";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createFeishuReminderAdapter } from "./channels/feishu-reminder";
import { createOpeningReminderRepository } from "@aistudy/database";
import { runJob } from "./runtime/run-job";
import { createCompileTeachingUnitWorkerDeps } from "./runtime/compile-teaching-unit-wiring";
import { createMediaTranscribeWorkerDeps } from "./runtime/media-transcribe-wiring";

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
  // PR-H: full registry validation (strict booleans, dependencies, no NEXT_PUBLIC_*) before any connection.
  const { env } = loadServerConfig(process.env, "worker") as Extract<ReturnType<typeof loadServerConfig>, { role: "worker" }>;
  const runner = await preflightParser();
  const openingModel = loadOpeningModelCatalog();
  const redis = createRedisConnection({ url: env.redisUrl });
  const producer = createProducerRedisConnection({ url: env.redisUrl });
  const reportError = (error: unknown) => console.error("worker background operation failed", error instanceof Error ? error.name : "unknown error");
  redis.on("error", reportError);
  producer.on("error", reportError);
  const sql = createSqlClient(env.databaseUrl);
  const workers: Worker[] = [];
  const openedQueues: ReturnType<typeof createQueues>[string][] = [];
  const tasks: ReturnType<typeof createSerialTask>[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    const failures: unknown[] = [];
    const closeAll = async (closers: Array<() => Promise<unknown>>) => {
      const results = await Promise.allSettled(closers.map((close) => Promise.resolve().then(close)));
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    };
    await closeAll(tasks.map((task) => () => task.stop()));
    await closeAll(workers.map((worker) => () => worker.close()));
    await closeAll(openedQueues.map((queue) => () => queue.close()));
    producer.disconnect();
    redis.disconnect();
    await closeAll([() => sql.end({ timeout: 5 })]);
    if (failures.length) {
      process.exitCode = 1;
      throw failures[0];
    }
  })();
  try {

  const repository = createOpeningJobRepository(sql);
  const privacyRepo = createOpeningPrivacyRepository(sql);
  const learning = createOpeningLearningRepository(sql);
  const retests = createOpeningRetestRepository(sql);
  const sources = createOpeningSourceRepository(sql, { quota: loadOpeningUploadQuota() });
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
    isCurrent: (id, at, claimToken) => reminders.isCurrent(id, at, claimToken),
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
  // TZ01: factory timeZone is fallback only; reserve() prefers planning_settings.timeZone
  // and counts completed spend via resolveBudgetLocalDay half-open bounds.
  const budget = createOpeningBudgetRepository(sql, { envCapCents: openingModel.dailyCapCents, pricingConfigured: openingModel.models.some(m => m.inputCentsPerMillion > 0 && m.outputCentsPerMillion > 0) });
  const models = createDbModelGateway(sql);
  const knowledge = createOpeningKnowledgeRepository(sql);
  const buildCourseKnowledge = createBuildCourseKnowledgeHandler({
    listAuthorizedChunks: (scope, courseId) => knowledge.listAuthorizedChunks(scope, courseId),
    listReferencedNodeIds: (scope, courseId) => knowledge.listReferencedNodeIds(scope, courseId),
    get: (scope, courseId) => knowledge.get(scope, courseId),
    replace: (scope, courseId, input) => knowledge.replace(scope, courseId, input),
    // Own task route and ledger entry; retries of one job reuse one reservation.
    resolveProvider: async (scope, job) => models.budgetedProvider(scope, "knowledge.extract", {
      budget: scopeBudget(budget, scope),
      operationId: `build-course-knowledge:${job.id}`,
    }),
  });
  const parseMedia = createParseMediaHandler({
    sources,
    chunks,
    storage,
    tempDir: env.parserTempDir,
    ...createMediaTranscribeWorkerDeps(sql, { budget, privacy: privacyRepo }),
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
  const tutorJobs = createOpeningTutorJobsRepository(sql);
  // Production compile-teaching-unit dependency construction (shared with tests).
  const compileTeachingUnit = createCompileTeachingUnitHandler(
    createCompileTeachingUnitWorkerDeps(sql, { budget, chunks, privacy: privacyRepo }),
  );
  const handlers = createHandlers(parse, {
    retest,
    remind,
    "build-course-knowledge": buildCourseKnowledge,
    "parse-media": parseMedia,
    "extract-study-actions": extractStudyActions,
    "compile-teaching-unit": compileTeachingUnit,
  });
  const memory = createOpeningMemoryRepository(sql);
  const tutorTurn = createTutorTurnHandler({
    tutorJobs,
    chunks,
    budget,
    provider: null,
    resolveModel: (scope, mode) => resolveTutorModel(sql, scope, mode),
    resolveFallbackModel: (scope, mode) => resolveTutorFallbackModel(sql, scope, mode),
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
    ...(loadFeatureSwitches().adaptivePlanning ? {
      planningContext: { read: (scope: { workspaceId: string; ownerUserId: string }, now: Date) => readOpeningConversationPlanningContext(sql, scope, now) },
    } : {}),
    learning: {
      insertHelpExposure: (scope, exposure) => learning.insertHelpExposure(scope, exposure),
    },
  });
  const queues = createQueues(producer, (queue) => openedQueues.push(queue));
  for (const [kind, queue] of Object.entries(queues)) {
    const worker = new Worker(queue.name, async (job) => {
    if (stopping) throw new Error("worker is shutting down");
    if (kind === "tutor") {
      const data = job.data as { jobId?: string };
      if (!data.jobId) throw new Error("tutor queue job is missing its tutor job id");
      await tutorTurn(data.jobId);
      return;
    }
    await runJob(repository, job.data.jobId ?? job.id, handlerForKind(kind, handlers));
  }, { connection: redis, concurrency: kind === "parse" ? 1 : 2 });
    workers.push(worker);
    worker.on("error", reportError);
  }
  const dispatch = createSerialTask(async () => {
    await repository.recoverExpired();
    await tutorJobs.recoverExpired();
    await dispatchPending({ repository, queues });
    await dispatchTutorTurns({ tutorJobs, queues });
  }, reportError);
  tasks.push(dispatch);
  timers.push(setInterval(() => { void dispatch.run(); }, 1000));
  // G4: slower interval for pending-upload TTL sweep (Data sweepExpiredPendingUploadsAll).
  // Returned swept ids are the notify hook — delivery skipped this wave.
  const sweepPendingUploads = createSweepPendingUploadsJob({
    sweepAll: (options) => sweepExpiredPendingUploadsAll(sql, options),
  });
  const sweep = createSerialTask(sweepPendingUploads, reportError);
  tasks.push(sweep);
  timers.push(setInterval(() => { void sweep.run(); }, PENDING_UPLOAD_SWEEP_INTERVAL_MS));
  process.once("SIGINT", () => { void shutdown().catch(reportError); });
  process.once("SIGTERM", () => { void shutdown().catch(reportError); });
  await dispatch.run();
  } catch (error) {
    await shutdown().catch(reportError);
    throw error;
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("index.ts") || entry.endsWith("index.js")) {
  void main().catch((error: unknown) => {
    console.error("worker startup failed", error instanceof Error ? error.name : "unknown error");
    process.exitCode = 1;
  });
}

export { createRetestCloseHandler } from "./jobs/retest-close";

export { createExtractStudyActionsHandler } from "./jobs/extract-study-actions";
export { createCompileTeachingUnitHandler } from "./jobs/compile-teaching-unit";
