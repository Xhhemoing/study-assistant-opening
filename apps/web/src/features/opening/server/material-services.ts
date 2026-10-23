import "server-only";
import { createOpeningParserHealthRepository, createOpeningMaterialManifestRepository, readMaterialAnswers } from "@aistudy/database";
import { createOpeningStudyExposureRepository } from "@aistudy/database";
import type { Sql } from "postgres";
export const readParserHealth = (sql: Sql) => createOpeningParserHealthRepository(sql).read();
export const materialManifestService = (sql: Sql) => createOpeningMaterialManifestRepository(sql);
export const materialAnswerService = (sql: Sql) => async (scope: Parameters<typeof readMaterialAnswers>[1], attemptId: string) => {
  const answers=await readMaterialAnswers(sql,scope,attemptId);
  if(answers.length) await createOpeningStudyExposureRepository(sql).deliver(scope,{
    releaseKey:`material-answer:${attemptId}`,contextAnchor:{attemptId,purpose:"history_solution"},
    origin:"history_solution",kind:"solution",level:"revealed",supportDomain:"math",
  });
  return answers;
};
