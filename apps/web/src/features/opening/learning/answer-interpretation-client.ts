import { answerInterpretationSnapshotSchema,learningObservationSchema,type AnswerInterpretationCorrection } from "@aistudy/contracts";
import { z } from "zod";
import { createSessionFetch } from "../../auth/session-expiry";
import { parseOpeningResponse } from "../client/parse-response";
import { OpeningApiError } from "../client/api";
const resultSchema=z.object({snapshot:answerInterpretationSnapshotSchema,observation:learningObservationSchema,replayed:z.boolean()}).strict();
export function createAnswerInterpretationClient(fetchImpl:typeof fetch=createSessionFetch()){
  async function request(id:string,init:RequestInit){const response=await fetchImpl(`/api/opening/observations/${id}/interpretation`,init),body=await response.json();
    if(!response.ok)throw new OpeningApiError(response.status,body?.error?.message??"无法读取转写校正记录",body?.error?.code??null);return body;}
  return {
  async read(id:string){return parseOpeningResponse(answerInterpretationSnapshotSchema,await request(id,{cache:"no-store"}));},
  async correct(id:string,input:AnswerInterpretationCorrection){return parseOpeningResponse(resultSchema,await request(id,{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)}));},
};}
