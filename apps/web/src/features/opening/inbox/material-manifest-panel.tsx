"use client";
import { useState } from "react";
import { BookOpenCheck, Save } from "lucide-react";
import { materialManifestSchema, type MaterialManifest } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { LearningAttemptForm } from "../learning/attempt-form";

/** Explicit owner classification, never model-inferred question numbering. */
export function MaterialManifestPanel({sourceId}:{sourceId:string}) {
 const [manifest,setManifest]=useState<MaterialManifest>({role:'mixed',sections:[],questions:[],answers:[]});
 const [version,setVersion]=useState(0),[revision,setRevision]=useState(0),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [answerCount,setAnswerCount]=useState(0),[withheld,setWithheld]=useState(true);
 const [page,setPage]=useState(1),[end,setEnd]=useState(1),[role,setRole]=useState<'exercise'|'answer_key'|'lecture'|'solution'|'exam_spec'>('exercise');
 const [family,setFamily]=useState(''),[number,setNumber]=useState(''),[sub,setSub]=useState(''),[text,setText]=useState('');
 const [target,setTarget]=useState(sourceId),[targetVersion,setTargetVersion]=useState(0),[status,setStatus]=useState<'trusted'|'disputed'|'unverified'>('unverified'),[reason,setReason]=useState('');
 const [courses,setCourses]=useState<Array<{id:string;title:string}>>([]),[courseId,setCourse]=useState(''),[question,setQuestion]=useState<MaterialManifest['questions'][number]|null>(null);
 async function load(reveal=false){setBusy(true);setMessage('');try{
  const r=await fetch(`/api/opening/sources/${sourceId}/material`,reveal?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reveal_answers'}),cache:'no-store'}:{cache:'no-store'}),body=await r.json();if(!r.ok)throw new Error(body.message);
  setAnswerCount(body.answerCount);setWithheld(body.answersWithheld);
  setVersion(body.sourceVersion);setTargetVersion(body.sourceVersion);setRevision(body.revision);setManifest(body.manifest?materialManifestSchema.parse(body.manifest):{role:'mixed',sections:[],questions:[],answers:[]});setLoaded(true);
  const c=await fetch('/api/courses',{cache:'no-store'});if(c.ok){const value=await c.json();setCourses(value.courses ?? []);}
 }catch(e){setMessage(e instanceof Error?e.message:'读取失败');}finally{setBusy(false);}}
 async function save(){setBusy(true);setMessage('');try{
  const value=materialManifestSchema.parse(manifest);const r=await fetch(`/api/opening/sources/${sourceId}/material`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({sourceVersion:version,expectedRevision:revision,manifest:value,mergeAnswerLinks:true})}),body=await r.json();
  if(!r.ok)throw new Error(body.message);setRevision(body.revision);setManifest(materialManifestSchema.parse(body.manifest));setAnswerCount(body.answerCount);setWithheld(body.answersWithheld);setMessage('分类与身份已保存；答案/详解不进入教学或通用检索。录入答案会记录曝光。');
 }catch(e){setMessage(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}
 const key={family,number,subquestion:sub};
 return <details className="space-y-3 border-t border-line pt-3"><summary className="cursor-pointer text-sm font-medium text-text">资料角色、原题编号与答案隔离</summary>
 <p className="text-xs text-text-2">按原件确认物理页段。未知混合页不进入教学；同页含题与答案时，先拆页或单独整理，不能把整页标为正文。</p>
 {!loaded?<button type="button" className={ui.secondary} onClick={()=>void load()} disabled={busy}>读取分类</button>:<>
 {withheld && answerCount>0?<div className="space-y-2"><p className="text-xs text-warn">{answerCount} 条答案已隐藏。编辑时查看答案会记录曝光，后续同页题目不能视为未见题。</p><button type="button" className={ui.secondary} disabled={busy} onClick={()=>void load(true)}>查看答案以编辑（记录曝光）</button></div>:null}
 <label className="block text-sm">整份资料角色<select className={ui.input} value={manifest.role} onChange={e=>setManifest(m=>({...m,role:e.target.value as MaterialManifest['role'],sections:[]}))}>{[['mixed','混合（按页段）'],['lecture','讲义'],['exercise','练习'],['answer_key','答案'],['solution','详解'],['exam_spec','考试要求']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
 <div className="grid gap-2 sm:grid-cols-3"><label className="text-sm">开始/题目/答案页<input className={ui.input} type="number" min={1} value={page} onChange={e=>setPage(Number(e.target.value))}/></label>
 {manifest.role==='mixed'?<><label className="text-sm">结束页<input className={ui.input} type="number" min={1} value={end} onChange={e=>setEnd(Number(e.target.value))}/></label><label className="text-sm">页段角色<select className={ui.input} value={role} onChange={e=>setRole(e.target.value as typeof role)}><option value="exercise">练习正文</option><option value="answer_key">答案</option><option value="solution">详解</option><option value="lecture">讲义</option><option value="exam_spec">考试要求</option></select></label></>:null}</div>
 {manifest.role==='mixed'?<><button type="button" className={ui.secondary} onClick={()=>setManifest(m=>({...m,sections:[...m.sections,{startPage:page,endPage:end,role}]}))}>添加页段</button><ul className="text-xs">{manifest.sections.map((s,i)=><li key={i}>{s.startPage}–{s.endPage} · {s.role} <button type="button" className={ui.quiet} onClick={()=>setManifest(m=>({...m,sections:m.sections.filter((_,j)=>j!==i)}))}>移除此页段</button></li>)}</ul></>:null}
 <div className="grid gap-2 sm:grid-cols-3"><label className="text-sm">练习族<input className={ui.input} value={family} onChange={e=>setFamily(e.target.value)} placeholder="如 T1"/></label><label className="text-sm">原编号<input className={ui.input} value={number} onChange={e=>setNumber(e.target.value)}/></label><label className="text-sm">子问（可空）<input className={ui.input} value={sub} onChange={e=>setSub(e.target.value)}/></label></div>
 <label className="block text-sm">题干或该题答案（仅录入这道题）<textarea className={ui.input} value={text} onChange={e=>setText(e.target.value)}/></label>
 <button type="button" className={ui.secondary} onClick={()=>setManifest(m=>({...m,questions:[...m.questions,{...key,page,stem:text}]}))}>登记正文题目</button>
 <details className="space-y-2"><summary className="cursor-pointer text-sm">登记答案关联／核验状态</summary><label className="block text-sm">正文资料 ID<input className={ui.input} value={target} onChange={e=>setTarget(e.target.value)}/></label><label className="block text-sm">正文资料版本<input className={ui.input} type="number" min={0} value={targetVersion} onChange={e=>setTargetVersion(Number(e.target.value))}/></label>
 <label className="block text-sm">答案状态<select className={ui.input} value={status} onChange={e=>setStatus(e.target.value as typeof status)}><option value="unverified">未核验</option><option value="disputed">有争议（不计分）</option><option value="trusted">本人已核验</option></select></label><label className="block text-sm">核验理由<input className={ui.input} value={reason} onChange={e=>setReason(e.target.value)}/></label>
 <button type="button" className={ui.secondary} onClick={()=>setManifest(m=>({...m,answers:[...m.answers.filter(a=>!(a.page===page&&a.questionSourceId===target&&a.question.family===family&&a.question.number===number&&a.question.subquestion===sub)),{page,questionSourceId:target,questionSourceVersion:targetVersion,question:key,text,status,reason}]}))}>添加／更新本题答案关联</button></details>
 <p className="text-xs text-text-2">已登记 {manifest.questions.length} 道正文题、{manifest.answers.length} 条答案关联。已保存的题目正文与身份不能在同版本内改写。</p>
 {!withheld ? <ul className="space-y-2 text-sm">{manifest.answers.map((a,i)=><li key={i} className="whitespace-pre-wrap rounded border border-line p-2">{a.question.family} · {a.question.number}{a.question.subquestion} · {a.status}：{a.text}<br/>核验理由：{a.reason || '未核验'}</li>)}</ul>:null}
 <button type="button" className={ui.primary} disabled={busy} onClick={()=>void save()}><Save size={16} aria-hidden/>保存分类</button>
 {manifest.questions.length?<><label className="block text-sm">练习归属课程<select className={ui.input} value={courseId} onChange={e=>setCourse(e.target.value)}><option value="">选择课程</option>{courses.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label><ul className="space-y-2">{manifest.questions.map((q,i)=><li key={i}><button type="button" className={ui.secondary} disabled={!courseId||busy} onClick={()=>setQuestion(q)}><BookOpenCheck size={16} aria-hidden/>{q.family} · {q.number}{q.subquestion} · 第{q.page}页</button></li>)}</ul></>:null}
 {question&&courseId?<LearningAttemptForm courseId={courseId} initialProblem={{sourceId,sourceVersion:version,stem:question.stem,materialQuestion:{sourceId,sourceVersion:version,family:question.family,number:question.number,subquestion:question.subquestion}}} onRecorded={()=>{}}/>:null}
 </>}{message?<p role="status" className="text-sm text-text-2">{message}</p>:null}</details>;
}
