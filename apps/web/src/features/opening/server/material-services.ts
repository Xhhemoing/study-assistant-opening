import "server-only";
import { createOpeningMaterialManifestRepository, deliverMaterialAnswers } from "@aistudy/database";
import type { Sql } from "postgres";
export const materialManifestService = (sql: Sql) => createOpeningMaterialManifestRepository(sql);
export const materialAnswerService = (sql: Sql) => (scope: Parameters<typeof deliverMaterialAnswers>[1], attemptId: string) => deliverMaterialAnswers(sql,scope,attemptId);
