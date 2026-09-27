import {
  createOpeningConversationRepository, readOpeningConversationSelection,
  createOpeningLearningRepository,
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
  type EphemeralProvider,
  type EphemeralTutorService,
} from "./tutor/ephemeral-service";
import {
  createOpeningBudgetRepository,
  createOpeningSourceRepository,
} from "@aistudy/database";
import { loadOpeningModel, loadOpeningTutorConfig } from "@aistudy/config";
import { createOpeningProvider } from "@aistudy/ai";

function openingLearningDbFromSql(sql: Sql) {
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
    async execute(text: string, params: unknown[] = []): Promise<void> {
      await sql.unsafe(text, params as never[]);
    },
  };
}

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
  return createTutorService({ conversations, sourceChunks,
    readSelection: (scope, id) => readOpeningConversationSelection(sql, scope, id),
  });
}

export function getObservationService(sql: Sql) {
  return createOpeningObservationService(
    createOpeningLearningRepository(openingLearningDbFromSql(sql)),
  );
}

export function getLearningReadService(sql: Sql) {
  const repo = createOpeningLearningRepository(openingLearningDbFromSql(sql));
  return createOpeningLearningReadService({
    assertOwnedCourse: (scope, courseId) => repo.assertOwnedCourse(scope, courseId),
    listObservationsForCourse: (scope, courseId) => repo.listObservationsForCourse(scope, courseId),
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
  const model = ephemeralOverride ? null : loadOpeningModel();
  const tutor = ephemeralOverride?.config ?? {
    ...loadOpeningTutorConfig(),
    inputCentsPerMillion: model?.inputCentsPerMillion ?? 0,
    outputCentsPerMillion: model?.outputCentsPerMillion ?? 0,
  };
  const provider = ephemeralOverride
    ? ephemeralOverride.provider
    : model && model.apiKey && model.dailyCapCents > 0
      ? createOpeningProvider({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.name,
      })
      : null;
  const budgetRepo = createOpeningBudgetRepository(sql, {
    dailyCapCents: model?.dailyCapCents ?? 100_000,
  });
  const sources = createOpeningSourceRepository(sql);
  const chunks = createOpeningSourceChunksRepository(sql);
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
        budget: {
          reserve: (entry) => budgetRepo.reserve(scope, entry),
          release: (requestId) => budgetRepo.release(requestId),
          settle: (reservationId, actualCents) => budgetRepo.settle(reservationId, actualCents),
          markUnknown: (reservationId) => budgetRepo.markUnknown(reservationId),
        },
        provider,
        config: tutor,
      }).replyEphemeral(scope, input, signal);
    },
  };
}
