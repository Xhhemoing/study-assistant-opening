import { z } from "zod";
import { answerInterpretationCorrectionSchema } from "@aistudy/contracts";
const schema=z.object({text:z.string().max(20000),reason:z.string().max(2000),request:answerInterpretationCorrectionSchema.nullable()}).strict();
export type AnswerInterpretationDraft=z.infer<typeof schema>;
export const answerInterpretationDraftKey=(namespace:string,rootId:string)=>`aistudy:answer-interpretation:${namespace}:${rootId}`;
export function readAnswerInterpretationDraft(namespace:string,rootId:string):AnswerInterpretationDraft|null{
  const raw=sessionStorage.getItem(answerInterpretationDraftKey(namespace,rootId));if(!raw)return null;
  const value=schema.parse(JSON.parse(raw));
  if(value.request&&(value.request.correctedTranscription!==value.text.trim()||value.request.reason!==value.reason.trim()))throw new Error("原校正请求与保存的文字不一致，未发送新请求。");
  return value;
}
export function writeAnswerInterpretationDraft(namespace:string,rootId:string,value:AnswerInterpretationDraft){
  sessionStorage.setItem(answerInterpretationDraftKey(namespace,rootId),JSON.stringify(schema.parse(value)));
}
