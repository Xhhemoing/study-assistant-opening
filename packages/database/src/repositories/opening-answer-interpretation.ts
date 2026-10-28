import { answerInterpretationCorrectionSchema,type AnswerInterpretationCorrection,type AnswerInterpretationSnapshot,type Scope } from "@aistudy/contracts";
import type { Sql,TransactionSql } from "postgres";
import { readOpeningAnswerInterpretationState } from "./opening-answer-interpretation-state";
import { learningError,lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { qualifyObservationRevision } from "./opening-observation-revision-history";
import { reviseOpeningLearningObservation } from "./opening-observation-revisions";

function transactionClient(tx:TransactionSql):Sql{return new Proxy(tx,{get(target,key,receiver){if(key==="begin")return (...args:unknown[])=>target.savepoint(nested=>(args.at(-1) as (db:TransactionSql)=>Promise<unknown>)(nested));return Reflect.get(target,key,receiver);}}) as unknown as Sql;}
async function snapshot(db:Sql|TransactionSql,scope:Scope,id:string):Promise<AnswerInterpretationSnapshot>{
  const state=await readOpeningAnswerInterpretationState(db,scope,id);
  await qualifyObservationRevision(db,scope,state.head);
  let available=false;
  if(state.workSource){const [photo]=await db`SELECT 1 FROM opening_sources s WHERE s.id=${state.workSource.id} AND s.workspace_id=${scope.workspaceId}
    AND s.upload_state='uploaded' AND (s.version=${state.workSource.version} OR EXISTS(SELECT 1 FROM opening_source_versions v WHERE v.source_id=s.id AND v.workspace_id=s.workspace_id
      AND v.version=${state.workSource.version} AND v.availability='available')) AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)`;
    available=!!photo;}
  const canCorrect=available&&!!state.original&&state.head.revision_kind!=="retract"&&state.head.server_evaluation==null;
  return {rootObservationId:String(state.root.id),headObservationId:String(state.head.id),originalAnswer:String(state.root.answer),workSource:state.workSource,
    originalTranscriptionObservationId:state.original?String(state.original.id):null,originalTranscription:state.originalText,
    currentInterpretation:state.active,versions:state.versions,canCorrect,reason:canCorrect?null:"请先读取原照片的批改转写；照片不可用或记录已撤回时不能校正。"};
}
export function createOpeningAnswerInterpretationRepository(sql:Sql){return {
  read:(scope:Scope,id:string)=>sql.begin("isolation level repeatable read read only",tx=>snapshot(tx,scope,id)),
  async correct(scope:Scope,id:string,raw:AnswerInterpretationCorrection){const input=answerInterpretationCorrectionSchema.parse(raw);
    return sql.begin(async tx=>{
      await lockWorkspaceLearningHistory(tx,scope);
      const state=await readOpeningAnswerInterpretationState(tx,scope,id);
      const [replay]=await tx`SELECT submitted_intent FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
      if(replay){const intent=replay.submitted_intent as {rootObservationId?:string;expectedHead?:string;answerInterpretation?:{correctedTranscription?:string;correctionReason?:string}};
        if(intent.rootObservationId!==state.root.id||intent.expectedHead!==input.expectedHead||intent.answerInterpretation?.correctedTranscription!==input.correctedTranscription
          ||intent.answerInterpretation.correctionReason!==input.reason)throw learningError("CONFLICT","同一次校正请求的内容已变化，请保留原请求后重新读取。");
        return {snapshot:await snapshot(tx,scope,id),observation:await qualifyObservationRevision(tx,scope,state.head),replayed:true};}
      const current=await snapshot(tx,scope,id);
      if(!current.canCorrect||!state.original||!state.workSource)throw learningError("CONFLICT",current.reason!);
      if(current.headObservationId!==input.expectedHead)throw learningError("CONFLICT","原作答已有新的校正或判分，请重新读取后保留输入核对。");
      if(input.correctedTranscription===(state.active?.correctedTranscription??current.originalTranscription)?.trim())throw learningError("VALIDATION","识别文字未变化，无需新增校正版。");
      const previous=state.versions.at(-1),metadata={kind:"photo_transcription" as const,version:state.versions.length+1,workSource:state.workSource,
        originalTranscriptionObservationId:String(state.original.id),originalTranscription:current.originalTranscription!,correctedTranscription:input.correctedTranscription,
        previousInterpretationObservationId:previous?.observationId??null,correctionReason:input.reason};
      const previousObservation=await qualifyObservationRevision(tx,scope,state.head);
      const result=await reviseOpeningLearningObservation(transactionClient(tx),scope,{rootObservationId:current.rootObservationId,revisesObservationId:current.headObservationId,
        expectedHead:input.expectedHead,revisionKind:"replace",reason:`照片转写校正：${input.reason}`,clientKey:input.clientKey,
        replacement:{answer:input.correctedTranscription,outcome:"unverified",assistance:previousObservation.assistance}},
        {answerInterpretation:metadata});
      return {snapshot:await snapshot(tx,scope,id),observation:result.observation!,replayed:false};
    });
  }};
}
