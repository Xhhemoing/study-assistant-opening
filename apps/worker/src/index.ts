import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { loadOpeningJobStaleConfig, loadWorkerStartupConfig } from "@aistudy/config";
import { assertConsumersActive, consumersReady, createWorkerReadiness, type ReadyConsumer } from "./runtime/worker-readiness";
import { runStartupWithBackoff } from "./runtime/startup-backoff";
import { createGradeObservationHandler } from "./jobs/grade-observation";
import { createOpeningAiGradingRepository, createOpeningAiGradingJobRepository,
  createOpeningParserHealthRepository, createOpeningPdfSegmentsRepository } from "@aistudy/database";
import { workerSmokeJobSchema } from "@aistudy/contracts";
import { PLATFORM_NAME, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningMemoryRepository, createOpeningPrivacyRepository, createOpeningSourceRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository, createOpeningLearningRepository, readOpeningCourseEvidence, readLearningPreferences, createOpeningRetestRepository, createOpeningKnowledgeRepository, createOpeningImportChunksRepository,
  createOpeningTutorLearnerContextRepository, createOpeningPlanningSettingsRepository, readLatestStemPromptsBySkill, createSqlClient, OpeningS3, sweepExpiredPendingUploadsAll, readOpeningConversationPlanningContext } from "@aistudy/database";
import { createDbModelGateway, resolveTutorFallbackModel, resolveTutorModel, scopeBudget } from "./runtime/model-gateway";
import { createTutorStreamWriter } from "./runtime/tutor-stream";
import { createSourcePageImages } from "./runtime/source-page-images";
import { loadFeatureSwitches, loadOpeningEmbeddingConfig, loadOpeningModelCatalog, loadOpeningTutorConfig, loadOpeningUploadQuota, loadServerConfig } from "@aistudy/config";
import { createOpeningSourceEmbeddingsRepository } from "@aistudy/database";
import { createIndexSourceHandler } from "./jobs/index-source";
import { createOpeningMaterialRetriever } from "./runtime/material-retrieval";
import { createRedisConnection, createProducerRedisConnection, createQueues } from "./runtime/queue";
import { createSerialTask } from "./runtime/lifecycle";
import { dispatchPending, dispatchTutorTurns } from "./runtime/dispatch";
import { createHandlers, handlerForKind } from "./runtime/handlers";
import { prepareWorkerRole, isParserQueue, reconcileParserConsumers } from "./runtime/worker-role";
import { validateParserPaths } from "./parsers/parser-preflight";
import { createParserHealthLease } from "./runtime/parser-health-lease";
import { createParseSourceHandler } from "./jobs/parse-source";
import { createTutorTurnHandler } from "./jobs/tutor-turn";
import { createTutorMetadataHandler } from "./jobs/tutor-metadata";
import { createRecognizePhotoQuestionHandler } from "./jobs/recognize-photo-question";
import { createOpeningPhotoRecognitionRepository } from "@aistudy/database";
import { tutorModelTask } from "@aistudy/ai";
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
import { runJob, type JobHandler } from "./runtime/run-job";
import { createCompileTeachingUnitWorkerDeps } from "./runtime/compile-teaching-unit-wiring";
import { createMediaTranscribeWorkerDeps } from "./runtime/media-transcribe-wiring";
import { createDbSystemQueryService, createDbAssistantProposalService } from "./runtime/system-query";
import { createOpeningEphemeralProvenanceRepository, createOpeningStudyExposureRepository, reconcileStaleTeachingGenerations } from "@aistudy/database";

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
  const startup = loadWorkerStartupConfig();
  let readiness = createWorkerReadiness(startup.readinessFile, { role: env.workerRole,
    release: realpathSync(process.cwd()), queueKinds: [] });

  // Reject invalid local parser paths before allocating connection resources.
  // The full OCR inference/report remains inside the managed startup lifecycle.
  if (env.workerRole !== "learning") await validateParserPaths();
  const openingModel = loadOpeningModelCatalog();
  const embeddingConfig = loadOpeningEmbeddingConfig();
  const redis = createRedisConnection({ url: env.redisUrl });
  const producer = createProducerRedisConnection({ url: env.redisUrl });
  const reportError = (error: unknown) => console.error("worker background operation failed", error instanceof Error ? error.name : "unknown error");
  redis.on("error", reportError);
  producer.on("error", reportError);
  let sql: ReturnType<typeof createSqlClient>;
  let parserHealthSql: ReturnType<typeof createSqlClient>;
  try {
    sql = createSqlClient(env.databaseUrl);
    try { parserHealthSql = createSqlClient(env.databaseUrl, { max: 1 }); }
    catch (error) { await sql.end({ timeout: 5 }); throw error; }
  } catch (error) {
    producer.disconnect();
    redis.disconnect();
    throw error;
  }
  // Isolate report writes so shutdown can cancel a hung renewal without
  // abandoning an INSERT that might later overwrite the retirement receipt.

  const parserHealth = createOpeningParserHealthRepository(parserHealthSql);
  const parserWorkerId = randomUUID();
  const workers: Worker[] = [];
  const consumers: ReadyConsumer[] = [];
  const parserConsumers: Array<{ kind: string; pause(): Promise<unknown>; resume(): Promise<unknown> }> = [];
  const learningConsumers: ReadyConsumer[] = [];
  const parsingConsumers: ReadyConsumer[] = [];
  const openedQueues: ReturnType<typeof createQueues>[string][] = [];
  const tasks: ReturnType<typeof createSerialTask>[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  let stopping = false;
  let parserStarted = false;
  let parserReportedAt = 0;
  let parserLease: ReturnType<typeof createParserHealthLease> | undefined;
  const parserState = createSerialTask(async () => {
    let current: boolean;
    do {
      current = parserLease?.isCurrent() ?? false;
      await reconcileParserConsumers(parserConsumers, () => parserLease?.isCurrent() ?? false, () => stopping);
    } while (!stopping && current !== parserLease?.isCurrent());
  }, reportError);
  tasks.push(parserState);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    stopping = true;
    readiness.invalidate();
    parserLease?.stop();
    for (const timer of timers) clearInterval(timer);
    const failures: unknown[] = [];
    const closeAll = async (closers: Array<() => Promise<unknown>>) => {
      const results = await Promise.allSettled(closers.map((close) => Promise.resolve().then(close)));
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    };
    // Pause fetching immediately, before draining a possibly hung health refresh.
    // Active jobs still finish under their ordinary execution fences.
    await parserState.stop();
    if (started) await closeAll(workers.map((worker) => () => worker.pause(true)));
    await closeAll([() => parserHealthSql.end({ timeout: 5 })]);
    await closeAll(tasks.map((task) => () => task.stop()));
    await closeAll(workers.map((worker) => () => worker.close(!started)));
    await closeAll(openedQueues.map((queue) => () => queue.close()));
    if (parserStarted) await closeAll([() => createOpeningParserHealthRepository(sql).retire(parserWorkerId)]);
    producer.disconnect();
    redis.disconnect();
    await closeAll([() => sql.end({ timeout: 5 })]);
    if (failures.length) {
      process.exitCode = 1;
      throw failures[0];
    }
  })();
  let started = false;
  const unavailable = (error: unknown) => {
    if (stopping) return;
    reportError(error);
    readiness.invalidate();
    process.exitCode = 1;
    void shutdown().catch(reportError);
  };
  redis.on("close", () => unavailable(new Error("Worker Redis disconnected")));
  producer.on("close", () => unavailable(new Error("Worker producer disconnected")));
  redis.on("error", unavailable);
  producer.on("error", unavailable);
  const onSignal = () => { void shutdown().catch(reportError); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
  const { parserRunner: runner, queueKinds, refreshParserHealth } = await prepareWorkerRole(env.workerRole, undefined,
    { record: async report => {
      const startedAt = performance.now();
      await parserHealth.record(parserWorkerId, report);
      parserReportedAt = startedAt;
    } });
  parserStarted = runner !== null;
  if (stopping) throw new Error("Worker stopped during parser startup");
  if (refreshParserHealth) {
    parserLease = createParserHealthLease({ reportedAt: parserReportedAt, refresh: refreshParserHealth,
      renewalTimeoutMs: startup.ocrTimeoutMs + 30_000,
      onUnavailable: error => {
        reportError(error);
        readiness.degrade();
        void parserState.run();
      },
      onAvailable: () => { if (!stopping) void parserState.run(); } });
    parserLease.assertCurrent();
    const refresh = createSerialTask(() => parserLease!.renew(), reportError);
    tasks.push(refresh);
    timers.push(setInterval(() => { void refresh.run(); }, 2 * 60_000));
  }

  const repository = createOpeningJobRepository(sql);
  const privacyRepo = createOpeningPrivacyRepository(sql);
  const learning = createOpeningLearningRepository(sql);
  const retests = createOpeningRetestRepository(sql);
  const sources = createOpeningSourceRepository(sql, { quota: loadOpeningUploadQuota() });
  const chunks = createOpeningSourceChunksRepository(sql);
  const storage = new OpeningS3(env.s3);
  const parserDisabled: JobHandler = async () => { throw new Error("parser queues are disabled for WORKER_ROLE=learning"); };
  const parse = runner ? createParseSourceHandler({ sources, chunks, storage, runner, tempDir: env.parserTempDir,
    segments: createOpeningPdfSegmentsRepository(sql), segmentTimeoutSeconds: startup.ocrSegmentTimeoutSeconds }) : parserDisabled;
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
  const budget = createOpeningBudgetRepository(sql, { envCapCents: openingModel.dailyCapCents, dailyQuotaMode: openingModel.dailyQuotaMode, parentCapCents: openingModel.parentCapCents, pricingConfigured: Boolean(embeddingConfig && embeddingConfig.inputCentsPerMillion > 0) || openingModel.models.some(m => m.inputCentsPerMillion > 0 && m.outputCentsPerMillion > 0) });
  const indexSource = createIndexSourceHandler({ repository: createOpeningSourceEmbeddingsRepository(sql),
    config: embeddingConfig, budget: scope => scopeBudget(budget, scope) });
  const models = createDbModelGateway(sql);
  const knowledge = createOpeningKnowledgeRepository(sql);
  const buildCourseKnowledge = createBuildCourseKnowledgeHandler({
    listAuthorizedChunks: (scope, courseId) => knowledge.listAuthorizedChunks(scope, courseId),
    listReferencedNodeIds: (scope, courseId) => knowledge.listReferencedNodeIds(scope, courseId),
    get: (scope, courseId) => knowledge.getForRebuild(scope, courseId),
    replace: (scope, courseId, input) => knowledge.replace(scope, courseId, input),
    // Own task route and ledger entry; retries of one job reuse one reservation.
    resolveProvider: async (scope, job, batch) => models.budgetedProvider(scope, "knowledge.extract", {
      budget: scopeBudget(budget, scope),
      operationId: `build-course-knowledge:${job.id}:batch:${batch.index}`,
      parentBudget: { id: `build-course-knowledge:${job.id}`, maxProviderCalls: Math.max(12, batch.count * 2) },
      beforeSend: () => knowledge.assertExtractionBatch(scope, batch.chunks[0]!.courseId, batch.chunks),
    }),
  });
  const parseMedia = runner ? createParseMediaHandler({
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
  }) : parserDisabled;
  const importChunks = createOpeningImportChunksRepository(sql);
  const extractStudyActions = createExtractStudyActionsHandler({
    listAuthorizedImportChunks: (scope, courseId, receiptIds) =>
      importChunks.listAuthorizedImportChunks(scope, courseId, receiptIds),
  });
  const tutorJobs = createOpeningTutorJobsRepository(sql);
  const tutorMetadata = createTutorMetadataHandler({ tutorJobs,
    callModel: (scope, mode, options) => models.call(scope, tutorModelTask(mode), { ...options, budget: scopeBudget(budget, scope) }),
  });
  // Production compile-teaching-unit dependency construction (shared with tests).
  const compileTeachingUnit = createCompileTeachingUnitHandler(
    createCompileTeachingUnitWorkerDeps(sql, { budget, chunks, privacy: privacyRepo }),
  );
  const handlers = createHandlers(parse, {
    "grade-observation": createGradeObservationHandler({ repository: createOpeningAiGradingRepository(sql), gateway: models,
      budget: scope => scopeBudget(budget, scope), images: createSourcePageImages(sql, storage) }),
    "recognize-photo-question": createRecognizePhotoQuestionHandler({ repository: createOpeningPhotoRecognitionRepository(sql), gateway: models,
      budget: scope => scopeBudget(budget, scope), images: createSourcePageImages(sql, storage) }),
    "index-source": indexSource,
    "tutor-metadata": tutorMetadata,
    retest,
    remind,
    "build-course-knowledge": buildCourseKnowledge,
    "parse-media": parseMedia,
    "extract-study-actions": extractStudyActions,
    "compile-teaching-unit": compileTeachingUnit,
  });
  const memory = createOpeningMemoryRepository(sql);
  const tutorTurn = createTutorTurnHandler({
    retrieveContext: createOpeningMaterialRetriever(sql, budget, embeddingConfig),
    learnerContext: createOpeningTutorLearnerContextRepository(sql),
    stream: createTutorStreamWriter(producer),
    streamExposures: createOpeningStudyExposureRepository(sql),
    onStreamUnavailable: reportError,
    systemQuery: createDbSystemQueryService(sql, "worker", { callModel: (scope, input, options) => models.call(scope, "tutor.listen", {
      ...options, input, budget: scopeBudget(budget, scope),
    }) }),
    proposals: createDbAssistantProposalService(sql, { callModel: (scope, input, options) => models.call(scope, "tutor.listen", {
      ...options, input, budget: scopeBudget(budget, scope),
    }) }),
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
    if (!queueKinds.has(kind)) continue;
    const worker = new Worker(queue.name, async (job) => {
    if (stopping) throw new Error("worker is shutting down");
    if (isParserQueue(kind)) parserLease!.assertCurrent();
    if (kind === "tutor") {
      const data = job.data as { jobId?: string };
      if (!data.jobId) throw new Error("tutor queue job is missing its tutor job id");
      await tutorTurn(data.jobId);
      return;
    }
    await runJob(repository, job.data.jobId ?? job.id, handlerForKind(kind, handlers));
  }, { connection: redis, name: `${process.pid}-${parserWorkerId}-${kind}`, concurrency: kind === "parse" || kind === "tutor-metadata" ? 1 : 2 });
    workers.push(worker);
    consumers.push({ waitUntilReady: () => worker.waitUntilReady(), isRunning: () => worker.isRunning(),
      isPaused: () => worker.isPaused(), getWorkers: () => queue.getWorkers(), name: worker.opts.name! });
    if (isParserQueue(kind)) {
      parsingConsumers.push(consumers[consumers.length - 1]!);
      parserConsumers.push({ kind,
        pause: async () => { if (!worker.isPaused()) await worker.pause(true); },
        resume: async () => { if (worker.isPaused()) await worker.resume(); } });
    } else learningConsumers.push(consumers[consumers.length - 1]!);
    worker.on("error", unavailable);
    worker.on("closed", () => unavailable(new Error("Worker consumer closed")));
  }
  if (consumers.length !== queueKinds.size) throw new Error("Worker consumer queue set is incomplete");
  await assertConsumersActive(consumers, startup.readyTimeoutMs);
  if (stopping) throw new Error("Worker stopped during startup");
  // Recreate with the complete, actually verified consumer set.
  readiness = createWorkerReadiness(startup.readinessFile, { role: env.workerRole,
    release: realpathSync(process.cwd()), queueKinds: [...queueKinds] });
  const heartbeat = createSerialTask(async () => {
    if (!await consumersReady(learningConsumers, startup.readyTimeoutMs)) { readiness.degrade(); return; }
    if (stopping) return;
    if (parserLease) {
      await parserState.run();
      if (stopping) return;
      if (!parserLease.isCurrent()) { readiness.degrade(); return; }
      try {
        if (!await consumersReady(parsingConsumers, startup.readyTimeoutMs)) { readiness.degrade(); return; }
      }
      catch (error) { readiness.degrade(); reportError(error); return; }
      if (stopping) return;
      if (!parserLease.isCurrent()) { readiness.degrade(); return; }
    }
    readiness.publish();
  }, unavailable);
  tasks.push(heartbeat);
  await heartbeat.run();
  if (stopping) throw new Error("Worker stopped before readiness");
  started = true;
  process.exitCode = undefined;
  timers.push(setInterval(() => { void heartbeat.run(); }, 5_000));
  const dispatch = createSerialTask(async () => {
    await createOpeningAiGradingJobRepository(sql).recoverExpired();
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
  // Backstop for jobs nobody polls: a lost queue message / dead compile must not leave a
  // lesson "正在准备讲解" or a tutor answer pending forever (web reads reconcile too).
  const staleJobs = loadOpeningJobStaleConfig();
  const sweep = createSerialTask(async () => {
    await sweepPendingUploads();
    await createOpeningEphemeralProvenanceRepository(sql).purgeExpiredQueries?.();
    await reconcileStaleTeachingGenerations(sql, { staleMs: staleJobs.teachingGenerateStaleMs });
    await tutorJobs.expireStale({ staleMs: staleJobs.tutorJobStaleMs });
  }, reportError);
  tasks.push(sweep);
  timers.push(setInterval(() => { void sweep.run(); }, PENDING_UPLOAD_SWEEP_INTERVAL_MS));

  await dispatch.run();
  } catch (error) {
    await shutdown().catch(reportError);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    throw error;
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("index.ts") || entry.endsWith("index.js")) {
  void runStartupWithBackoff(main, loadWorkerStartupConfig()).catch((error: unknown) => {
    console.error("worker startup failed", error instanceof Error ? error.name : "unknown error");
    process.exitCode = 1;
  });
}

export { createRetestCloseHandler } from "./jobs/retest-close";

export { createExtractStudyActionsHandler } from "./jobs/extract-study-actions";
export { createCompileTeachingUnitHandler } from "./jobs/compile-teaching-unit";
