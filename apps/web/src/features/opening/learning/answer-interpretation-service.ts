import { answerInterpretationCorrectionSchema,uuidSchema,type Scope } from "@aistudy/contracts";
import { createOpeningAnswerInterpretationRepository } from "@aistudy/database";
import type { Sql } from "postgres";
export function createAnswerInterpretationService(sql:Sql){const repository=createOpeningAnswerInterpretationRepository(sql);return {
  read:(scope:Scope,id:string)=>repository.read(scope,uuidSchema.parse(id)),
  correct:(scope:Scope,id:string,raw:unknown)=>repository.correct(scope,uuidSchema.parse(id),answerInterpretationCorrectionSchema.parse(raw)),
};}
