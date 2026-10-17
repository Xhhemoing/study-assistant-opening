import "server-only";
import { createOpeningExamSprintRepository } from "@aistudy/database";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import type { Sql } from "postgres";

// The complete answer bank is reachable only through this server adapter.
export const getExamSprintService = (sql: Sql) => createOpeningExamSprintRepository(sql, EXAM_SPRINT_PACK);
