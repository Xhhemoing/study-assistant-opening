import type { Scope } from "@aistudy/contracts";
import type { Sql,TransactionSql } from "postgres";
import { readOpeningAnswerInterpretationState } from "./opening-answer-interpretation-state";
import { readOpeningAiGradingLedger } from "./opening-ai-grading-ledger";
/** A transcription correction cannot escape an unresolved bill for the same captured photo. */
export async function openingAnswerInterpretationPriorCostUnresolved(db:Sql|TransactionSql,scope:Scope,observationId:string){
  const state=await readOpeningAnswerInterpretationState(db,scope,observationId);
  if(!state.active)return false;
  const own=String(state.head.grading_operation_id??`ai-grade:${scope.workspaceId}:${state.head.id}`);
  for(const operation of new Set(state.ordered.map(row=>String(row.grading_operation_id??`ai-grade:${scope.workspaceId}:${row.id}`)))){
    if(operation===own)continue;
    const ledger=await readOpeningAiGradingLedger(db,scope,operation);
    if(ledger==="unknown"||ledger==="in_flight")return true;
  }
  return false;
}
