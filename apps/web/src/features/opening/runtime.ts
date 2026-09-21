import {
  createOpeningConversationRepository,
  createOpeningLearningRepository,
  createOpeningSourceChunksRepository,
  type OpeningConversationRepository,
  type OpeningSourceChunksRepository,
} from "@aistudy/database";
import type { Sql } from "postgres";
import { getAuthRuntime } from "../../server/runtime";
import { requirePrincipal } from "../auth/service";
import { createOpeningObservationService } from "./learning/observation-service";
import { createTutorService, type TutorService } from "./tutor/tutor-service";
import { createOpeningPlanService } from "./planning/plan-service";

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
  return createTutorService({ conversations, sourceChunks });
}

export function getObservationService(sql: Sql) {
  return createOpeningObservationService(
    createOpeningLearningRepository(openingLearningDbFromSql(sql)),
  );
}

export function getPlanService(sql: import("postgres").Sql) {
  return createOpeningPlanService(sql);
}
