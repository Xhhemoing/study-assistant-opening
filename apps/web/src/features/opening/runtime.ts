import { createOpeningAttemptService } from "./learning/attempt-service";
import {
  createOpeningConversationRepository, readOpeningConversationSelection,
  createOpeningLearningRepository, createOpeningLearningAttemptRepository, readOpeningCourseEvidence, readOpeningCourseObservationHeads,
  createOpeningSourceChunksRepository,
  type OpeningConversationRepository,
  type OpeningSourceChunksRepository,
} from "@aistudy/database";
import type { Sql } from "postgres";
import { getAuthRuntime } from "../../server/runtime";
import { requirePrincipal } from "../auth/service";
import { createOpeningObservationService } from "./learning/observation-service";
import { createOpeningLearningReadService } from "./learning/read-service";
import { createTutorService, type TutorService } from "./tutor/tutor-service";
import { createOpeningPlanService } from "./planning/plan-service";
import {
  createEphemeralTutorService,
  EphemeralServiceError,
  type EphemeralScope,
  type EphemeralProvider,
  type EphemeralTutorService,
} from "./tutor/ephemeral-service";
import {
  createOpeningBudgetRepository,
  createOpeningEphemeralProvenanceRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceRepository,
} from "@aistudy/database";
import { loadOpeningModelCatalog, loadOpeningTutorConfig } from "@aistudy/config";
import { resolveTutorModel } from "../../../../worker/src/runtime/tutor-model";
import { createSourcePageImages, openingPageStorage } from "../../../../worker/src/runtime/source-page-images";

export async function requireOpeningScope(request: Request) {
  const runtime = getAuthRuntime();
  const principal = await requirePrincipal(runtime, request);
  return {
    runtime,
    principal,
    scope: {
      workspaceId: principal.workspaceId,
      ownerUserId: principal.userId,
    },
    sql: runtime.sql,
  };
}

export function getTutorService(sql: Sql): TutorService {
  const conversations: OpeningConversationRepository =
    createOpeningConversationRepository(sql);
  const sourceChunks: OpeningSourceChunksRepository =
    createOpeningSourceChunksRepository(sql);
  return createTutorService({ conversations, sourceChunks, attempts: createOpeningLearningAttemptRepository(sql),
    readSelection: (scope, id) => readOpeningConversationSelection(sql, scope, id),
  });
}

export function getObservationService(sql: Sql) {
  return createOpeningObservationService(
    createOpeningLearningRepository(sql),
  );
}

export function getLearningReadService(sql: Sql) {
  const repo = createOpeningLearningRepository(sql);
  return createOpeningLearningReadService({
    assertOwnedCourse: (scope, courseId) => repo.assertOwnedCourse(scope, courseId),
    readCourseEvidence: (scope, courseId) => readOpeningCourseEvidence(sql, scope, courseId),
    readCourseObservationHeads: (scope, courseId) => readOpeningCourseObservationHeads(sql, scope, courseId),
  });
}

export function getPlanService(sql: import("postgres").Sql) {
  return createOpeningPlanService(sql);
}

type EphemeralConfig = {
  maxContextCharacters: number;
  reservedCents: number;
  maxOutputTokens: number;
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
};

let ephemeralOverride: { provider: EphemeralProvider | null; config: EphemeralConfig } | null = null;

/** Test seam. Production uses loadOpeningModel and never claims vendor zero-retention. */
export function setEphemeralTutorDepsForTests(
  deps: { provider: EphemeralProvider | null; config: EphemeralConfig } | null,
): void {
  ephemeralOverride = deps;
}

export function getEphemeralTutorService(sql: Sql): EphemeralTutorService {
  const override = ephemeralOverride;
  const catalog = override ? null : loadOpeningModelCatalog();
  const tutor = override?.config ?? { ...loadOpeningTutorConfig(), inputCentsPerMillion: 0, outputCentsPerMillion: 0 };
  const budgetRepo = createOpeningBudgetRepository(sql, {
    dailyCapCents: catalog?.dailyCapCents ?? 100_000,
  });
  const sources = createOpeningSourceRepository(sql);
  const chunks = createOpeningSourceChunksRepository(sql);
  const privacySnapshot = (scope: EphemeralScope) => sql.begin("isolation level repeatable read read only", async tx => {
    const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (!owners.length) throw new EphemeralServiceError("NOT_FOUND", "workspace not found", 404);
    const privacy = createOpeningPrivacyRepository(tx);
    return {
      epoch: await privacy.getWorkspaceEpoch(scope),
      excludedSourceIds: await privacy.listExcludedSourceIds(scope),
    };
  });
  return {
    replyEphemeral(scope, input, signal) {

      return createEphemeralTutorService({
        sources: {
          listOwnedIds: async (ownedScope, sourceIds) => {
            const found: string[] = [];
            for (const id of sourceIds) {
              try {
                await sources.get(ownedScope, id);
                found.push(id);
              } catch {
                /* missing or foreign source stays unauthorized */
              }
            }
            return found;
          },
        },
        chunks,
        pageImages: createSourcePageImages(sql, openingPageStorage()),
        provenance: createOpeningEphemeralProvenanceRepository(sql),
        privacy: {
          snapshot: privacySnapshot,
          currentEpoch: async ownedScope => (await privacySnapshot(ownedScope)).epoch,
        },
        budget: {
          reserve: (entry) => budgetRepo.reserve(scope, entry),
          release: (requestId) => budgetRepo.release(requestId),
          settle: (reservationId, actualCents) => budgetRepo.settle(reservationId, actualCents),
          markUnknown: (reservationId) => budgetRepo.markUnknown(reservationId),
        },
        provider: override?.provider ?? null,
        resolveModel: override ? undefined : (ownedScope, mode) => resolveTutorModel(sql, ownedScope, mode),
        config: tutor,
      }).replyEphemeral(scope, input, signal);
    },
  };
}

export function getAttemptService(sql: Sql) { return createOpeningAttemptService(sql); }
