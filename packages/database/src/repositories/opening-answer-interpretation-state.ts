import { answerInterpretationMetadataSchema,aiGradingWorkSourceSchema,type AnswerInterpretationMetadata,type AnswerInterpretationSnapshot,type Scope } from "@aistudy/contracts";
import type { Sql,TransactionSql } from "postgres";
import { learningError,learningIso } from "./opening-learning-facts";
import { isDeepStrictEqual } from "node:util";
type Row=Record<string,unknown>;
const recordedTranscription=(row:Row)=>{
  const current=(row.ai_evaluation as {transcription?:unknown}|null)?.transcription;
  const historical=(row.submitted_intent as {aiGrading?:{proposal?:{transcription?:unknown}}}|null)?.aiGrading?.proposal?.transcription;
  return typeof current==="string"?current:typeof historical==="string"?historical:null;
};
/** Only a complete owned revision chain with the original captured photo can supply interpretation provenance. */
export async function readOpeningAnswerInterpretationState(db:Sql|TransactionSql,scope:Scope,id:string){
  const [root]=await db`SELECT root.* FROM opening_learning_observations o JOIN opening_learning_observations root
    ON root.id=COALESCE(o.root_observation_id,o.id) AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
    JOIN workspaces w ON w.id=o.workspace_id AND w.owner_user_id=o.owner_user_id WHERE o.id=${id}
      AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}`;
  if(!root)throw learningError("NOT_FOUND","原作答不存在。");
  const all=await db`SELECT * FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND COALESCE(root_observation_id,id)=${String(root.id)}`;
  const ordered:Row[]=[],headId=String(root.effective_head_id??root.id),seen=new Set<string>();let current:Row|undefined=root;
  while(current&&!seen.has(String(current.id))){seen.add(String(current.id));ordered.push(current);if(current.id===headId)break;
    const next=all.filter(row=>row.revises_observation_id===current!.id);if(next.length!==1)throw learningError("CONFLICT","原作答修订链不完整，请重新读取。");current=next[0];}
  if(ordered.at(-1)?.id!==headId||ordered.length!==all.length)throw learningError("CONFLICT","原作答修订链不完整，请重新读取。");
  const head=ordered.at(-1)!;
  const photo=aiGradingWorkSourceSchema.safeParse(root.grading_work_source??ordered.find(row=>(row.ai_evaluation as {workSource?:unknown}|null)?.workSource)?.grading_work_source);
  const workSource=photo.success?photo.data:null;
  const original=workSource?ordered.find(row=>isDeepStrictEqual(row.grading_work_source??(row.ai_evaluation as {workSource?:unknown}|null)?.workSource,workSource)
    &&recordedTranscription(row)!==null):null;
  const originalText=original?recordedTranscription(original):null;
  const versions:AnswerInterpretationSnapshot["versions"]=[];
  for(const row of ordered){const raw=(row.submitted_intent as {answerInterpretation?:unknown}|null)?.answerInterpretation;
    if(raw===undefined)continue;
    const metadata=answerInterpretationMetadataSchema.parse(raw),previous=versions.at(-1);
    if(!original||!workSource||!isDeepStrictEqual(metadata.workSource,workSource)||metadata.originalTranscriptionObservationId!==original.id
      ||metadata.originalTranscription!==originalText
      ||metadata.version!==versions.length+1||metadata.previousInterpretationObservationId!==(previous?.observationId??null)
      ||row.answer!==metadata.correctedTranscription||row.attempt_id!==root.attempt_id||row.item_version_id!==root.item_version_id)
      throw learningError("CONFLICT","已保存的转写来源无法核对，未使用它重新批改。");
    versions.push({observationId:String(row.id),metadata,recordedAt:learningIso(row.recorded_at)!});
  }
  const latest=versions.at(-1),active=latest&&head.answer===latest.metadata.correctedTranscription?latest.metadata:null;
  return {root,head,ordered,workSource,original,originalText,versions,active};
}
export async function readOpeningAnswerInterpretationMetadata(db:Sql|TransactionSql,scope:Scope,id:string):Promise<AnswerInterpretationMetadata|null>{
  return (await readOpeningAnswerInterpretationState(db,scope,id)).active;
}
