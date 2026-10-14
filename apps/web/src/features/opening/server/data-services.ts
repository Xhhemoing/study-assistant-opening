/**
 * Opening application services for Web route handlers (plan §7.4).
 *
 * Route handlers authenticate, validate and call these services; only this
 * server adapter layer (and the other `server-only` composition roots) wires
 * repositories from @aistudy/database. Marked `server-only` so a Client
 * Component import fails at build time; the boundary gate
 * (scripts/check-server-boundary.mjs) fails earlier in lint/verify:ci.
 *
 * Not imported by apps/worker (worker has its own entrypoint and composition).
 */
import "server-only";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  createOpeningActionDigestDecisionsRepository,
  createOpeningAiSettingsRepository,
  createOpeningInterventionSettingsRepository,
  createOpeningModelProvidersRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningAdaptivePrefsRepository,
  createOpeningReminderRepository,
  createOpeningTutorJobsRepository,
  OpeningBudgetError,
  OpeningConversationError,
  OpeningNoteError,
  OpeningS3,
  OpeningSourceError,
  OpeningStorageError,
  readLearningPreferences,
  readOpeningAssistantReviewCandidates,
  readOpeningCourseLearningHistory,
  readOpeningCourseLearningSummary,
  readOpeningMaterialOrganization,
  readOpeningRetestReviewCandidates,
  readOpeningSourceContent,
  setCourseLearningPreferences,
} from "@aistudy/database";
import type { Sql } from "postgres";
import { createOpeningReminderService } from "../planning/reminder-service";

type Tail<F> = F extends (sql: Sql, ...rest: infer R) => infer O ? (...rest: R) => O : never;
const bind = <F extends (sql: Sql, ...rest: never[]) => unknown>(fn: F, sql: Sql) =>
  ((...rest: never[]) => fn(sql, ...rest)) as Tail<F>;

/** Query services: owner-scoped reads (scope enforced inside the repository SQL). */
export function openingQueries(sql: Sql) {
  return {
    assistantReviewCandidates: bind(readOpeningAssistantReviewCandidates, sql),
    retestReviewCandidates: bind(readOpeningRetestReviewCandidates, sql),
    courseLearningHistory: bind(readOpeningCourseLearningHistory, sql),
    courseLearningSummary: bind(readOpeningCourseLearningSummary, sql),
    materialOrganization: bind(readOpeningMaterialOrganization, sql),
    sourceContent: bind(readOpeningSourceContent, sql),
    learningPreferences: bind(readLearningPreferences, sql),
    setCourseLearningPreferences: bind(setCourseLearningPreferences, sql),
  };
}

export const getReminderService = (sql: Sql) =>
  createOpeningReminderService(createOpeningReminderRepository(sql));
export const getPlanningSettingsService = (sql: Sql) => createOpeningPlanningSettingsRepository(sql);
export const getAdaptivePrefsService = (sql: Sql) => createOpeningAdaptivePrefsRepository(sql);
export const getInterventionSettingsService = (sql: Sql) => createOpeningInterventionSettingsRepository(sql);
export const getActionDigestDecisionStore = (sql: Sql) => createOpeningActionDigestDecisionsRepository(sql);

type Scope = Parameters<ReturnType<typeof createOpeningTutorJobsRepository>["get"]>[0];
type Job = NonNullable<Awaited<ReturnType<ReturnType<typeof createOpeningTutorJobsRepository>["get"]>>>;

/** Tutor job polling/cancel. Cancellation never claims provider termination. */
export function getTutorJobService(sql: Sql) {
  const repo = createOpeningTutorJobsRepository(sql);
  return {
    get: (scope: Scope, id: string) => repo.get(scope, id),
    findPendingForConversation: (scope: Scope, conversationId: string) =>
      repo.findPendingForConversation(scope, conversationId),
    /** `cancelled` null => not found; `conflict` => exists but not cancellable. */
    async cancel(scope: Scope, id: string): Promise<{ job: Job; conflict: boolean } | null> {
      const job = await repo.cancel(scope, id);
      if (job) return { job, conflict: false };
      const existing = await repo.get(scope, id);
      return existing ? { job: existing, conflict: true } : null;
    },
  };
}

/** AI readiness inputs (preference, custom models, planning settings). */
export function readAiReadinessInputs(sql: Sql, scope: Scope) {
  return Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
    createOpeningPlanningSettingsRepository(sql).get(scope),
  ]);
}

/** Object-storage writers for the DingTalk callback; credentials stay server-side. */
export function getOpeningObjectWriter() {
  const storage = new OpeningS3({
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "aistudy",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  });
  return async (input: { key: string; bytes: Uint8Array; mime: string }) => {
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: input.key, Body: input.bytes, ContentType: input.mime }));
  };
}

const dataErrors = {
  source: OpeningSourceError,
  storage: OpeningStorageError,
  conversation: OpeningConversationError,
  note: OpeningNoteError,
  budget: OpeningBudgetError,
} as const;
type DataErrorKind = keyof typeof dataErrors;

/**
 * Type guard for repository errors so route handlers can map them to HTTP
 * without importing @aistudy/database.
 */
export function isOpeningDataError<K extends DataErrorKind>(
  error: unknown,
  kind: K,
): error is InstanceType<(typeof dataErrors)[K]> {
  return error instanceof dataErrors[kind];
}
