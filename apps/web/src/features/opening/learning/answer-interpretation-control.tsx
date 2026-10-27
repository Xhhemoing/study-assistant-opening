"use client";
import { useEffect,useMemo,useRef,useState } from "react";
import type { AnswerInterpretationCorrection,AnswerInterpretationSnapshot,LearningObservation } from "@aistudy/contracts";
import { createAnswerInterpretationClient } from "./answer-interpretation-client";
import { sourceViewerHref } from "../inbox/source-viewer";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { readAnswerInterpretationDraft,writeAnswerInterpretationDraft } from "./answer-interpretation-draft";

export function AnswerInterpretationControl({observationId,onUpdated,disabled=false,api}:{observationId:string;onUpdated:(record:LearningObservation)=>void;disabled?:boolean;api?:ReturnType<typeof createAnswerInterpretationClient>}){
  const client=useMemo(()=>api??createAnswerInterpretationClient(),[api]);
  const [snapshot,setSnapshot]=useState<AnswerInterpretationSnapshot|null>(null),[text,setText]=useState(""),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [unknown,setUnknown]=useState(false),[conflict,setConflict]=useState(false),[open,setOpen]=useState(false);
  const [namespace]=useState(getVerifiedSessionNamespace),[storageError,setStorageError]=useState("");
  const pending=useRef<AnswerInterpretationCorrection|null>(null),requestVersion=useRef(0);
  const draft=useRef({text:"",reason:""});
  useEffect(()=>()=>{requestVersion.current+=1;},[]);
  function owned(){return namespace!==null&&getVerifiedSessionNamespace()===namespace;}
  function persist(rootId:string,draft:{text:string;reason:string;request:AnswerInterpretationCorrection|null}){if(!owned())return false;try{writeAnswerInterpretationDraft(namespace!,rootId,draft);setStorageError("");return true;}catch{setStorageError("无法保存这次校正的信息，尚未提交。请复制文字并恢复浏览器存储后再确认。");return false;}}
  function edit(patch:Partial<{text:string;reason:string}>){if(!snapshot||pending.current)return;draft.current={...draft.current,...patch};setText(draft.current.text);setReason(draft.current.reason);persist(snapshot.rootObservationId,{...draft.current,request:null});}
  async function load(){const version=++requestVersion.current;setBusy(true);setError("");try{const value=await client.read(observationId);
    if(version!==requestVersion.current||!owned())return;
    const restored=readAnswerInterpretationDraft(namespace!,value.rootObservationId);
    setSnapshot(value);if(restored){let request=restored.request;
      if(request&&value.headObservationId!==request.expectedHead){
        if(!persist(value.rootObservationId,{text:restored.text,reason:restored.reason,request:null}))return;
        request=null;setError("这份作答已有更新，刚才的校正不能覆盖新内容；这不表示刚才的保存一定成功。文字已保留，请核对校正版历史后再保存。");
      }
      pending.current=request;setUnknown(request!==null);draft.current={text:restored.text,reason:restored.reason};setText(restored.text);setReason(restored.reason);}
    else if(!pending.current&&!conflict){draft.current={text:value.currentInterpretation?.correctedTranscription??value.originalTranscription??"",reason:""};setText(draft.current.text);}setConflict(false);
  }catch(error){if(version===requestVersion.current)setError(userFacingMessage(error,"原作答保留，暂无法读取转写记录。"));}finally{if(version===requestVersion.current)setBusy(false);}}
  async function save(){if(busy||disabled||conflict||!snapshot||!owned()||storageError)return;
    const retryingUnknown=pending.current!==null;
    const input=pending.current??{expectedHead:snapshot.headObservationId,correctedTranscription:text.trim(),reason:reason.trim(),clientKey:crypto.randomUUID()};
    if(!persist(snapshot.rootObservationId,{text:input.correctedTranscription,reason:input.reason,request:input}))return;
    pending.current=input;setBusy(true);setError("");const version=++requestVersion.current;
    try{const value=await client.correct(observationId,input);if(version!==requestVersion.current||!owned())return;
      persist(value.snapshot.rootObservationId,{text:input.correctedTranscription,reason:input.reason,request:null});pending.current=null;setUnknown(false);setSnapshot(value.snapshot);onUpdated(value.observation);
    }catch(error){if(version!==requestVersion.current||!owned())return;
      if(!retryingUnknown&&error&&typeof error==="object"&&"status" in error&&(error.status===409||error.status===400)){
        setConflict(error.status===409);setUnknown(false);pending.current=null;persist(snapshot.rootObservationId,{text:input.correctedTranscription,reason:input.reason,request:null});}
      else setUnknown(true);
      setError(userFacingMessage(error,"保存结果暂未确认；再次确认会沿用这次校正的文字，不会另存一份或再次收费。"));
    }finally{if(version===requestVersion.current)setBusy(false);}}
  if(!owned())return <p className="text-xs text-text-3">请先验证原账户与工作区，再恢复照片转写草稿。</p>;
  return <section className="space-y-3 rounded-lg border border-line p-3" aria-label="照片转写校正">
    <button type="button" className="min-h-11 text-sm text-accent underline underline-offset-4 disabled:opacity-50" disabled={busy||disabled} onClick={()=>{setOpen(value=>!value);if(!snapshot)void load();}}>核对照片与转写</button>
    {snapshot?<button type="button" className="min-h-11 text-sm text-accent underline underline-offset-4 disabled:opacity-50" disabled={busy||disabled} onClick={()=>void load()}>重新读取当前作答版本</button>:null}
    {open&&snapshot?<div className="space-y-3">
      {snapshot.workSource?<a className="inline-flex min-h-10 text-sm text-accent underline" href={sourceViewerHref(snapshot.workSource.id,snapshot.workSource.version,{page:snapshot.workSource.physicalPage})} target="_blank" rel="noreferrer">查看原图 · 第{snapshot.workSource.physicalPage}页 · 版本{snapshot.workSource.version}</a>:null}
      <details><summary className="min-h-10 cursor-pointer text-sm text-text-2">原提交与原识别文字（保留）</summary><p className="whitespace-pre-wrap break-words text-sm text-text-2">原提交：{snapshot.originalAnswer||"（照片作答）"}</p><p className="whitespace-pre-wrap break-words text-sm text-text-2">原识别：{snapshot.originalTranscription??"尚无图片转写"}</p></details>
      {snapshot.versions.length?<ol aria-label="转写校正版历史" className="space-y-2 text-sm text-text-2">{snapshot.versions.map(version=><li key={version.observationId}><p>校正版{version.metadata.version} · {version.metadata.correctionReason}</p><p className="whitespace-pre-wrap break-words">{version.metadata.correctedTranscription}</p></li>)}</ol>:null}
      {snapshot.canCorrect?<><label className="block text-sm text-text">校正识别文字<textarea rows={5} maxLength={20000} className="mt-1 w-full rounded border border-line bg-surface p-3" value={text} disabled={busy||unknown||disabled} onChange={event=>edit({text:event.target.value})}/></label>
        <label className="block text-sm text-text">识别错误说明<input maxLength={2000} className="mt-1 min-h-11 w-full rounded border border-line bg-surface p-3" value={reason} disabled={busy||unknown||disabled} onChange={event=>edit({reason:event.target.value})}/></label>
        <p className="text-xs leading-6 text-text-3">只校正原图识别，不补写解答。保存不会调用模型；原提交时间和帮助记录保留。重新批改需另行确认，可能产生费用。</p>
        {conflict?<button type="button" className="min-h-11 text-sm text-accent underline" onClick={()=>void load()}>重新读取当前版本并保留输入</button>:null}
        <button type="button" className="min-h-11 rounded border border-line px-3 text-sm text-text disabled:opacity-50" disabled={busy||disabled||conflict||!!storageError||!text.trim()||!reason.trim()} onClick={()=>void save()}>{busy?"正在保存…":unknown?"确认同一次校正保存结果":"保存校正版（不重新批改）"}</button>
      </>:<p className="text-sm text-text-2">{snapshot.reason}</p>}
    </div>:null}
    {error?<p role="status" className="text-sm text-warn">{error}</p>:null}
    {storageError?<p role="status" className="text-sm text-warn">{storageError}</p>:null}
  </section>;
}
