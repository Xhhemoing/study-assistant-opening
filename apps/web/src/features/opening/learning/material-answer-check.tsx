"use client";
import { useState } from "react";
import { BookOpenCheck } from "lucide-react";
import { z } from "zod";
import { materialAnswerReadSchema } from "@aistudy/contracts";
import { LearningProse } from "../assistant/learning-prose";
import { ui } from "../design/ui";
export const answersSchema=z.array(materialAnswerReadSchema);
export function MaterialAnswerCheck({attemptId}:{attemptId:string}) {
 const [answers,setAnswers]=useState<z.infer<typeof answersSchema>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function load(){setBusy(true);setError('');try{
  const r=await fetch(`/api/opening/attempts/${attemptId}/answers`,{cache:'no-store'});const value=await r.json();
  if(!r.ok)throw new Error(value.message ?? '答案暂不可读取');setAnswers(answersSchema.parse(value));
 }catch(e){setError(e instanceof Error?e.message:'读取失败');}finally{setBusy(false);}}
 return <section className="space-y-3 border-t border-line pt-3" aria-label="资料答案核对">
 <button type="button" className={ui.secondary} disabled={busy} onClick={()=>void load()}><BookOpenCheck size={16} aria-hidden />{busy?'正在读取…':'作答已保存，核对本题参考答案'}</button>
 {error?<p role="alert" className="text-sm text-danger">{error}</p>:null}
 {answers?.length===0?<p className="text-sm text-text-2">本题尚未关联答案，请先核验资料分类。</p>:null}
 {answers?.map((a,i)=><div key={i} className="space-y-2 rounded border border-line p-3"><p className="text-xs text-text-2">{a.status==='disputed'?'有争议 · 不计分、不增加薄弱度':a.status==='trusted'?'已人工核验':'尚未核验'} · 资料第 {a.page} 页</p><LearningProse text={a.text} />{a.reason?<p className="text-sm text-text-2">核验理由：{a.reason}</p>:null}</div>)}
 </section>;
}
