import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { loadOpeningJobStaleConfig, loadWorkerStartupConfig, type WorkerEnv } from "@aistudy/config";
import { assertConsumersActive, consumersReady, createWorkerReadiness, type ReadyConsumer } from "./runtime/worker-readiness";
import { runStartupWithBackoff } from "./runtime/startup-backoff";
import { createGradeObservationHandler } from "./jobs/grade-observation";
import { createOpeningExplicitRegradeRequestRepository, createOpeningAiGradingRepository, createOpeningAiGradingJobRepository, recordOpeningTutorTiming,
  createOpeningParserHealthRepository, createOpeningPdfSegmentsRepository, createOpeningSourceVisualRecognitionsRepository } from "@aistudy/database";
import { workerSmokeJobSchema } from "@aistudy/contracts";
import { PLATFORM_NAME, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningMemoryRepository, createOpeningPrivacyRepository, createOpeningSourceRepository, createOpeningSourceChunksRepository, createOpeningTutorJobsRepository, createOpeningLearningRepository, readOpeningCourseEvidence, readLearningPreferences, createOpeningRetestRepository, createOpeningKnowledgeRepository, createOpeningImportChunksRepository,
  createOpeningTutorLearnerContextRepository, createOpeningPlanningSettingsRepository, readLatestStemPromptsBySkill, createSqlClient, OpeningS3, sweepExpiredPendingUploadsAll, readOpeningConversationPlanningContext } from "@aistudy/database";
import { createDbModelGateway, resolveTutorFallbackModel, resolveTutorModel, scopeBudget } from "./runtime/model-gateway";
import { createWorkerTutorStreamWriter } from "./runtime/tutor-stream";
import { createSourcePageImages } from "./runtime/source-page-images";
import { createSourceVisualRecognition } from "./runtime/source-visual-recognition";
import { loadFeatureSwitches, loadOpeningEmbeddingConfig, loadOpeningModelCatalog, loadOpeningTutorConfig, loadOpeningUploadQuota, loadServerConfig } from "@aistudy/config";
import { createOpeningSourceEmbeddingsRepository } from "@aistudy/database";
import { createIndexSourceHandler } from "./jobs/index-source";
import { createOpeningMaterialRetriever } from "./runtime/material-retrieval";
import { createRedisConnection, createProducerRedisConnection, createQueue, createQueues } from "./runtime/queue";
import { createSerialTask } from "./runtime/lifecycle";
import { dispatchPending, dispatchTutorTurns } from "./runtime/dispatch";
import { handlerForKind } from "./runtime/handlers";
import { prepareWorkerRole, isParserQueue, reconcileParserConsumers, workerRunsParser } from "./runtime/worker-role";
import type { ParserRunner } from "./parsers/types";
import { createLogisticsChamberDeps } from "./chambers/chamber-guard";
import { validateParserPaths } from "./parsers/parser-preflight";
import { createParserHealthLease } from "./runtime/parser-health-lease";
import { createParseSourceHandler } from "./jobs/parse-source";
import { createTutorTurnHandler } from "./jobs/tutor-turn";
import { createSpanTutorNextAction } from "./runtime/span-tutor-next-action";
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

type WorkerSql = ReturnType<typeof createSqlClient>;

function createModelServices(sql: WorkerSql, openingModel: ReturnType<typeof loadOpeningModelCatalog>,
  embeddingConfig: ReturnType<typeof loadOpeningEmbeddingConfig>) {
  // TZ01: factory timeZone is fallback only; reserve() prefers planning_settings.timeZone
  // and counts completed spend via resolveBudgetLocalDay half-open bounds.
  const budget = createOpeningBudgetRepository(sql, { envCapCents: openingModel.dailyCapCents, dailyQuotaMode: openingModel.dailyQuotaMode, parentCapCents: openingModel.parentCapCents, pricingConfigured: Boolean(embeddingConfig && embeddingConfig.inputCentsPerMillion > 0) || openingModel.models.some(m => m.inputCentsPerMillion > 0 && m.outputCentsPerMillion > 0) });
  const models = createDbModelGateway(sql);
  return { budget, models, embeddingConfig };
}

function createLogisticsHandlers(sql: WorkerSql, { budget, models, embeddingConfig }: ReturnType<typeof createModelServices>) {
  const knowledge = createOpeningKnowledgeRepository(sql);
  const buildCourseKnowledge = createBuildCourseKnowledgeHandler({
    listAuthorizedChunks: (scope, courseId) => knowledge.listAuthorizedChunks(scope, courseId),
    listReferencedNodeIds: (scope, courseId) => knowledge.listReferencedNodeIds(scope, courseId),
    get: (scope, courseId) => knowledge.getForRebuild(scope, courseId),
    replace: (scope, courseId, input) => knowledge.replace(scope, courseId, input),
    onBuildCompleted: async (scope, courseId, coveredSourceVersions) => {
      await knowledge.reconcileCourseMaterials(scope, courseId, { coveredSourceVersions });
    },
    // Own task route and ledger entry; retries of one job reuse one reservation.
    resolveProvider: async (scope, job, batch) => models.budgetedProvider(scope, "knowledge.extract", {
      budget: scopeBudget(budget, scope),
      operationId: `build-course-knowledge:${job.id}:batch:${batch.index}`,
      parentBudget: { id: `build-course-knowledge:${job.id}`, maxProviderCalls: Math.max(12, batch.count * 2) },
      beforeSend: () => knowledge.assertExtractionBatch(scope, batch.chunks[0]!.courseId, batch.chunks),
    }),
  });
  const indexSource = createIndexSourceHandler({ repository: createOpeningSourceEmbeddingsRepository(sql),
    config: embeddingConfig, budget: scope => scopeBudget(budget, scope) });
  const importChunks = createOpeningImportChunksRepository(sql);
  const extractStudyActions = createExtractStudyActionsHandler({
    listAuthorizedImportChunks: (scope, courseId, receiptIds) =>
      importChunks.listAuthorizedImportChunks(scope, courseId, receiptIds),
  });
  const reminders = createOpeningReminderRepository(sql);
  const feishu = createFeishuReminderAdapter({ credential: process.env.FEISHU_REMINDER_CREDENTIAL ?? null });
  const planningSettings = createOpeningPlanningSettingsRepository(sql);
  const deps = createLogisticsChamberDeps({
    indexSource, buildCourseKnowledge, extractStudyActions,
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
    sendReminder: (input, signal) => feishu.send(input, signal),
  });
  return {
    remind: createRemindHandler({
      record: deps.record, isCurrent: deps.isCurrent, externalConfig: deps.externalConfig,
      resolveTimeZone: deps.resolveTimeZone, send: deps.sendReminder,
    }),
    "index-source": deps.indexSource, "extract-study-actions": deps.extractStudyActions,
    "build-course-knowledge": deps.buildCourseKnowledge,
  };
}

function createParserHandlers(sql: WorkerSql, env: WorkerEnv, runner: ParserRunner, segmentTimeoutSeconds: number,
  { budget, models }: ReturnType<typeof createModelServices>) {
  const sources = createOpeningSourceRepository(sql, { quota: loadOpeningUploadQuota() });
  const chunks = createOpeningSourceChunksRepository(sql);
  const storage = new OpeningS3(env.s3);
  const privacyRepo = createOpeningPrivacyRepository(sql);
  const visualRecognitions = createOpeningSourceVisualRecognitionsRepository(sql);
  const knowledge = createOpeningKnowledgeRepository(sql);
  const parse = createParseSourceHandler({ sources, chunks, storage, runner, tempDir: env.parserTempDir,
    segments: createOpeningPdfSegmentsRepository(sql), segmentTimeoutSeconds,
    assertCurrent: (scope, identity) => visualRecognitions.assertCurrent(scope, identity),
    ...createSourceVisualRecognition({ repository: visualRecognitions, gateway: models,
      budget: scope => scopeBudget(budget, scope), storage }),
    onSourceReady: async (scope, { sourceId }) => {
      await knowledge.reconcileCoursesForSource(scope, { sourceId });
    },
  });
  const parseMedia = createParseMediaHandler({
    sources,
    chunks,
    storage,
    tempDir: env.parserTempDir,
    ...createMediaTranscribeWorkerDeps(sql, { budget, privacy: privacyRepo }),
    onSourceReady: async (scope, { sourceId }) => {
      await knowledge.reconcileCoursesForSource(scope, { sourceId });
    },
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
  return { parse, "parse-media": parseMedia };
}

function createTeachingHandlers(sql: WorkerSql, env: WorkerEnv, producer: ReturnType<typeof createProducerRedisConnection>,
  tutorJobs: ReturnType<typeof createOpeningTutorJobsRepository>, reportError: (error: unknown) => void,
  { budget, models, embeddingConfig }: ReturnType<typeof createModelServices>) {
  const tutorStream = createWorkerTutorStreamWriter(producer, reportError);
  const privacyRepo = createOpeningPrivacyRepository(sql);
  const learning = createOpeningLearningRepository(sql);
  const retests = createOpeningRetestRepository(sql);
  const chunks = createOpeningSourceChunksRepository(sql);
  const storage = new OpeningS3(env.s3);
  const retest = createRetestCandidateHandler({
    readLearningPreferences: (scope, courseId) => readLearningPreferences(sql, scope, courseId),
    readCourseEvidence: (scope, courseId) => readOpeningCourseEvidence(sql, scope, courseId),
    listDueRetests: (scope, courseId) => retests.listDueEvidence(scope, courseId),
    saveCandidates: (scope, candidates, epoch, jobId) => retests.saveCandidates(scope, candidates, epoch, jobId),
    readStemPromptsBySkill: (scope, courseId) => readLatestStemPromptsBySkill(sql, scope, courseId),
  });
  const tutorMetadata = createTutorMetadataHandler({ tutorJobs,
    callModel: (scope, mode, options) => models.call(scope, tutorModelTask(mode), { ...options, budget: scopeBudget(budget, scope) }),
  });
  // Production compile-teaching-unit dependency construction (shared with tests).
  const compileTeachingUnit = createCompileTeachingUnitHandler(
    createCompileTeachingUnitWorkerDeps(sql, { budget, chunks, privacy: privacyRepo }),
  );
  const handlers = {
    "grade-observation": createGradeObservationHandler({ repository: createOpeningAiGradingRepository(sql), gateway: models,
      budget: scope => scopeBudget(budget, scope), images: createSourcePageImages(sql, storage) }),
    "recognize-photo-question": createRecognizePhotoQuestionHandler({ repository: createOpeningPhotoRecognitionRepository(sql), gateway: models,
      budget: scope => scopeBudget(budget, scope), images: createSourcePageImages(sql, storage) }),
    "tutor-metadata": tutorMetadata,
    retest,
    "compile-teaching-unit": compileTeachingUnit,
  };
  const memory = createOpeningMemoryRepository(sql);
  const tutorTurn = createTutorTurnHandler({
    nextAction: createSpanTutorNextAction(sql),
    timing: { record: (scope, input) => recordOpeningTutorTiming(sql, scope, input) },
    onTimingUnavailable: reportError,
    retrieveContext: createOpeningMaterialRetriever(sql, budget, embeddingConfig),
    learnerContext: createOpeningTutorLearnerContextRepository(sql),
    stream: tutorStream,
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
  return { handlers, tutorTurn, disconnectStream: tutorStream.disconnect };
}

export async function main(): Promise<void> {
  // PR-H: full registry validation (strict booleans, dependencies, no NEXT_PUBLIC_*) before any connection.
  const { env } = loadServerConfig(process.env, "worker") as Extract<ReturnType<typeof loadServerConfig>, { role: "worker" }>;
  const startup = loadWorkerStartupConfig();
  let readiness = createWorkerReadiness(startup.readinessFile, { role: env.workerRole,
    release: realpathSync(process.cwd()), queueKinds: [] });

  // Reject invalid local parser paths before allocating connection resources.
  // The full OCR inference/report remains inside the managed startup lifecycle.
  const runsParser = workerRunsParser(env.workerRole);
  if (runsParser) await validateParserPaths();
  const openingModel = loadOpeningModelCatalog();
  const embeddingConfig = loadOpeningEmbeddingConfig();
  const redis = createRedisConnection({ url: env.redisUrl });
  const producer = createProducerRedisConnection({ url: env.redisUrl });
  const reportError = (error: unknown) => console.error("worker background operation failed", error instanceof Error ? error.name : "unknown error");
  redis.on("error", reportError);
  producer.on("error", reportError);
  let sql: ReturnType<typeof createSqlClient>;
  let parserHealthSql: WorkerSql | undefined;
  try {
    sql = createSqlClient(env.databaseUrl);
    try { if (runsParser) parserHealthSql = createSqlClient(env.databaseUrl, { max: 1 }); }
    catch (error) { await sql.end({ timeout: 5 }); throw error; }
  } catch (error) {
    producer.disconnect();
    redis.disconnect();
    throw error;
  }
  // Isolate report writes so shutdown can cancel a hung renewal without
  // abandoning an INSERT that might later overwrite the retirement receipt.

  const parserHealth = parserHealthSql && createOpeningParserHealthRepository(parserHealthSql);
  const parserWorkerId = randomUUID();
  const workers: Worker[] = [];
  let tutorWorker: Worker | undefined;
  let teaching: ReturnType<typeof createTeachingHandlers> | undefined;
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
    if (parserHealthSql) await closeAll([() => parserHealthSql!.end({ timeout: 5 })]);
    await closeAll(tasks.map((task) => () => task.stop()));
    // A tutor consumer can already have an append in flight during startup.
    // Drain it before closing the control connection or releasing SQL locks.
    await closeAll(workers.map((worker) => () => worker.close(!started && worker !== tutorWorker)));
    teaching?.disconnectStream();
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
    { record: parserHealth && (async report => {
      const startedAt = performance.now();
      await parserHealth.record(parserWorkerId, report);
      parserReportedAt = startedAt;
    }) });
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
  const modelServices = createModelServices(sql, openingModel, embeddingConfig);
  // Legacy parser workers also own dispatcher/recovery duties even with no teaching consumers.
  const tutorJobs = env.workerRole === "logistics" ? null : createOpeningTutorJobsRepository(sql, { tutorStreamRedisUrl: env.redisUrl });
  if (queueKinds.has("tutor") && tutorJobs) {
    teaching = createTeachingHandlers(sql, env, producer, tutorJobs, reportError, modelServices);
  }
  const handlers: Record<string, JobHandler> = {
    ...(runner && createParserHandlers(sql, env, runner, startup.ocrSegmentTimeoutSeconds, modelServices)),
    ...(queueKinds.has("remind") && createLogisticsHandlers(sql, modelServices)),
    ...teaching?.handlers,
  };
  const trackQueue = (queue: ReturnType<typeof createQueue>) => {
    openedQueues.push(queue);
    return queue;
  };
  const queues = tutorJobs ? createQueues(producer, trackQueue) : Object.fromEntries(
    [...queueKinds].map(kind => [kind, trackQueue(createQueue(kind, producer))]),
  );
  for (const [kind, queue] of Object.entries(queues)) {
    if (!queueKinds.has(kind)) continue;
    const worker = new Worker(queue.name, async (job) => {
      if (stopping) throw new Error("worker is shutting down");
      if (isParserQueue(kind)) parserLease!.assertCurrent();
      if (kind === "tutor") {
        const data = job.data as { jobId?: string };
        if (!teaching || !data.jobId) throw new Error("tutor queue job is missing its teaching handler or job id");
        await teaching.tutorTurn(data.jobId);
      } else {
        await runJob(repository, job.data.jobId ?? job.id, handlerForKind(kind, handlers));
      }
    }, { connection: redis, name: `${process.pid}-${parserWorkerId}-${kind}`, concurrency: kind === "parse" || kind === "tutor-metadata" ? 1 : 2 });
    workers.push(worker);
    if (kind === "tutor") tutorWorker = worker;
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
  // The shared outbox and expired-job recovery cover all kinds. The teaching
  // peer (or a legacy worker) owns that work for a split deployment.
  const dispatch = tutorJobs && createSerialTask(async () => {
    await createOpeningExplicitRegradeRequestRepository(sql).recoverConfirmed();
    await createOpeningAiGradingJobRepository(sql).recoverExpired();
    await repository.recoverExpired();
    await tutorJobs.recoverExpired();
    await dispatchPending({ repository, queues });
    await dispatchTutorTurns({ tutorJobs, queues });
  }, reportError);
  if (dispatch) {
    tasks.push(dispatch);
    timers.push(setInterval(() => { void dispatch.run(); }, 1000));
  }
  // G4: slower interval for pending-upload TTL sweep (Data sweepExpiredPendingUploadsAll).
  // Returned swept ids are the notify hook — delivery skipped this wave.
  const sweepPendingUploads = env.workerRole !== "teaching" && createSweepPendingUploadsJob({
    sweepAll: (options) => sweepExpiredPendingUploadsAll(sql, options),
  });
  // Backstop for jobs nobody polls: a lost queue message / dead compile must not leave a
  // lesson "正在准备讲解" or a tutor answer pending forever (web reads reconcile too).
  const staleJobs = loadOpeningJobStaleConfig();
  const sweep = createSerialTask(async () => {
    if (sweepPendingUploads) await sweepPendingUploads();
    if (!tutorJobs) return;
    await createOpeningEphemeralProvenanceRepository(sql).purgeExpiredQueries?.();
    await reconcileStaleTeachingGenerations(sql, { staleMs: staleJobs.teachingGenerateStaleMs });
    await tutorJobs.expireStale({ staleMs: staleJobs.tutorJobStaleMs });
  }, reportError);
  tasks.push(sweep);
  timers.push(setInterval(() => { void sweep.run(); }, PENDING_UPLOAD_SWEEP_INTERVAL_MS));

  await dispatch?.run();
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

export { createExtractStudyActionsHandler } from "./jobs/extract-study-actions";
export { createCompileTeachingUnitHandler } from "./jobs/compile-teaching-unit";
