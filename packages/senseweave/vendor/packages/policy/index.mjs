import {presentationConstraints} from './constraints.mjs';
import {planningLists} from './lists.mjs';
import {qualityNotes} from './evidence.mjs';
import {scoreCandidate as score} from './features.mjs';
import {scoreImplicit,isImplicitCandidate,tableTimeline} from './implicit.mjs';
import {discoverProseStructures} from '../formats/prose.mjs';
import {groundingViolations,validateProposalBlock} from '../core/grounding.mjs';
/** Local-first presentation decisions. Scores are design heuristics, NOT probabilities or
 * measured learning gains. Data availability and user control are hard gates before scoring.
 */
import {discoverFormats} from '../formats/index.mjs';
import {validateDocument,plainDocument,splitText,SCHEMA_VERSION,requireContract,cleanText,CATALOG,validId} from '../core/document.mjs';
import {negotiateCapabilities} from '../core/capabilities.mjs';
export const POLICY_VERSION='0.5-local-3';
export const DEFAULT_POLICY=Object.freeze({mode:'auto',maxEnhancements:2,maxVisualCost:4,minScore:0.68});
const TASKS=['auto','lookup','compare','trend','relation','explain','review','inspect','plan'];
export function normalizePolicy(input={}) {
  requireContract(input&&typeof input==='object'&&!Array.isArray(input),'POLICY','Expected policy object');
  const p={...DEFAULT_POLICY,...input};
  requireContract(['auto','off','suggest','always'].includes(p.mode),'POLICY','Invalid policy mode');
  requireContract(Number.isInteger(p.maxEnhancements)&&p.maxEnhancements>=0&&p.maxEnhancements<=8,'POLICY','maxEnhancements 0–8');
  requireContract(Number.isFinite(p.maxVisualCost)&&p.maxVisualCost>=0&&p.maxVisualCost<=24,'POLICY','maxVisualCost 0–24');
  requireContract(Number.isFinite(p.minScore)&&p.minScore>=0&&p.minScore<=1,'POLICY','minScore 0–1');
  return {mode:p.mode,maxEnhancements:p.maxEnhancements,maxVisualCost:p.maxVisualCost,minScore:p.minScore};
}
export function resolveContext(context={}) {
  requireContract(context&&typeof context==='object'&&!Array.isArray(context),'CONTEXT','Expected context');
  const prompt=cleanText(context.prompt??'',6000),task=context.task??'auto',preference=context.preference??'auto';
  requireContract(TASKS.includes(task)&&['auto','text','visual'].includes(preference),'CONTEXT','Unknown task/preference');
  requireContract(context.viewport===undefined||['compact','wide'].includes(context.viewport),'CONTEXT','Unknown viewport');
  // Only instructions from the trusted host's current user prompt are considered; never the answer.
  if(context.fields!==undefined)requireContract(context.fields&&typeof context.fields==='object'&&typeof context.fields.x==='string'&&typeof context.fields.y==='string'&&context.fields.x.length<=200&&context.fields.y.length<=200,'CONTEXT','Invalid field projection');
  const hard=presentationConstraints(context),noUI=hard.noUI;
  const exact=task==='lookup'||/(?:逐字|原样|不要改写|仅翻译|只翻译)|\b(?:verbatim|translate only|exact output|do not reformat)\b/i.test(hard.instruction);
  const rules=[['trend',/趋势|走势|随时间|时间序列|\b(?:trend|over time|time series)\b/i],['compare',/比较|对比|优缺点|区别|差异|\b(?:compare|versus|vs)\b/i],['relation',/相关性|散点|两个变量|\b(?:correlation|scatter)\b/i],['inspect',/检查|查看数据|查找|检索|排序|调试|\b(?:inspect|search|sort|debug)\b/i],['review',/复习|\breview\b/i],['explain',/解释|理解|讲解|原理|\bexplain\b/i],['plan',/计划|清单|\bplan\b/i]];
  const matched=rules.filter(([,r])=>r.test(hard.instruction)).map(([name])=>name);
  const tasks=task==='auto'?(matched.length?matched:['auto']):[task];
  return {task:tasks[0],tasks,taskSource:task==='auto'?(matched.length?'prompt':'unspecified'):'explicit',
    preference,viewport:context.viewport??'wide',reducedMotion:context.reducedMotion===true,screenReader:context.screenReader===true,sensitive:context.sensitive===true,noUI,exact,allowedComponents:hard.allowedComponents};
}
/** Stable selection key; line and scatter views of one table are different choices. */
export function candidateKey(c) {const b=c.block??c;return b.type==='plot'?`${c.id}:plot:${b.data.kind}${c.projection?':'+c.projection.xKey+':'+c.projection.yKey:''}`:`${c.id}:${b.type}${c.projection?':'+c.projection.xKey+':'+c.projection.yKey:''}`;}
const VARIANT_TASKS=['compare','trend','relation'];
/** A two-column table whose axis is an explicit time/sequence and whose measure has a unit. */
function temporalTable(c){
  if(c.block.type!=='table'||c.block.data.columns.length!==2||c.block.data.rows.length<3)return false;
  const [a,b]=c.block.data.columns;
  return ['temporal','ordinal'].includes(a.kind)&&b.kind==='quantitative'&&!!b.unit&&b.unit!=='未声明';
}
function plotAlternative(candidate,task,context={}) {
  if(candidate.block.type!=='table')return null;
  const {columns,rows,inlineRows}=candidate.block.data;
  // Numeric alternatives cannot preserve host-rendered inline semantics. Keep the
  // table whenever any cell/header has distinct original inline source.
  if(columns.some(c=>c.inline!==undefined&&(c.inline.trim()!==c.label||/[`$*_[\]\\]/.test(c.inline)))||
    inlineRows?.some((r,i)=>r.some((source,j)=>source!==null&&typeof rows[i][j]==='string'&&
      (source.trim()!==rows[i][j]||/[`$*_[\]\\]/.test(source)))))return null;
  if(rows.length<3)return null;
  const y=columns.map((c,i)=>({c,i})).filter(x=>x.c.kind==='quantitative'&&x.c.unit&&x.c.unit!=='未声明');
  const fields=context.fields;
  const named=(items,key)=>items.filter(x=>x.c.key===key||x.c.label===key);
  const measures=fields?named(y,fields.y):y;
  const words=presentationConstraints(context).instruction;
  const mentioned=measures.filter(x=>{
    const label=x.c.label.replace(/\s*[（(\[].*$/, '').trim();
    if(!label)return false;
    if(/^[A-Za-z0-9_ ]+$/.test(label)){
      const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      return new RegExp('(?:^|[^A-Za-z0-9_])'+escaped+'(?=$|[^A-Za-z0-9_])','i').test(words);
    }
    return words.includes(label);
  });
  const ys=fields?measures:measures.length===1?measures:mentioned;
  if(ys.length!==1)return null;
  const {c:yc,i:yi}=ys[0];
  const rest=columns.map((c,i)=>({c,i})).filter(x=>x.i!==yi);
  const xs=fields?named(rest,fields.x):rest.filter(x=>task==='trend'?['temporal','ordinal'].includes(x.c.kind):task==='relation'?x.c.kind==='quantitative':x.c.kind==='nominal');
  // Preserve the established two-column numeric-axis case, but never guess among extra axes.
  const axes=fields?xs:xs.length?xs:rest.length===1?rest:[];
  if(axes.length!==1)return null;
  const {c:xc,i:xi}=axes[0];let block;
  if(task==='compare'&&new Set(rows.map(r=>r[xi])).size===rows.length&&xc.kind==='nominal'&&rows.length<=20&&rows.every(r=>typeof r[xi]==='string'&&typeof r[yi]==='number'))block={type:'chart',data:{unit:yc.unit,rows:rows.map(r=>({label:r[xi],value:r[yi]})),note:'由原表逐行映射，未生成、补齐或汇总新数据。'}};
  else if((task==='trend'&&['temporal','ordinal','quantitative'].includes(xc.kind))||(task==='inspect'&&['temporal','ordinal'].includes(xc.kind)&&rows.length>=4)||(task==='relation'&&xc.kind==='quantitative'))block={type:'plot',data:{kind:task==='relation'?'scatter':'line',xKind:xc.kind,xLabel:xc.label,yLabel:yc.label,yUnit:yc.unit,points:rows.map(r=>({x:xc.kind==='ordinal'&&typeof r[xi]==='number'?String(r[xi]):r[xi],y:r[yi]}))}};
  if(!block)return null;
  try {block.id=candidate.id;const v=validateDocument({schemaVersion:SCHEMA_VERSION,id:'probe',revision:1,title:'',blocks:[block]}).blocks[0];return {...candidate,block:v,variant:true,projection:{xKey:xc.key,yKey:yc.key,omittedKeys:columns.filter((_,i)=>i!==xi&&i!==yi).map(c=>c.key),rowMapping:'identity'},fidelity:{level:'projection',losses:[]}};}catch{return null;}
}
/**
 * How a supplementary view (a component grounded verbatim in one contiguous span, e.g. a chart
 * read from a sentence) is shown: 'replace' (default) shows the component in place of that span
 * with the verbatim original one click away; 'append' keeps the span as text and adds the view after it.
 * Text projections, copy and every fallback always carry the full original either way.
 */
export function normalizePlacement(value) {
  requireContract(value===undefined||value==='replace'||value==='append','PLACEMENT',"placement must be 'replace' or 'append'");
  return value??'replace';
}
const SUPPLEMENTARY_NOTE='原句保留在组件前，组件只作补充视图';
/** True when a selected candidate is shown in place of its verbatim source span. */
export function replacesSource(c,placement) {
  return c.placement==='after'&&placement==='replace'&&(c.fidelity?.level??'exact')==='exact'&&(c.sourceRef?.kind??'text')==='text'&&Number.isInteger(c.start)&&Number.isInteger(c.end)&&c.end>c.start;
}
export function preparePresentation(text,options={}) {
  cleanText(text,60000);
  const policy=normalizePolicy(options.policy),context=resolveContext(options.context),cap=negotiateCapabilities(options.capabilities);
  let veto=null;
  if(context.noUI||context.exact||options.mode==='text')veto='用户要求文字或原样输出';
  else if(options.autoDiscover===false||policy.mode==='off')veto='自动增强已关闭';
  else if(options.final===false)veto='流式正文先显示；完成后再一次性决策';
  else if(!cap.rich||!cap.maxInteractiveBlocks)veto='宿主不支持增强';
  // Hard refusal/streaming/unsupported host: avoid format parsing entirely.
  const discovery=veto?{candidates:[],diagnostics:[]}:discoverFormats(text,{inputFormat:options.inputFormat,columns:options.columns,final:options.final!==false});
  if(!veto&&options.dataSnapshot){
    const snapshot=options.dataSnapshot;validId(snapshot.id);
    const block=validateDocument({schemaVersion:SCHEMA_VERSION,id:'snapshot',revision:1,title:'',blocks:[{id:'snapshot_'+snapshot.id,type:'table',data:{columns:snapshot.columns,rows:snapshot.rows}}]}).blocks[0];
    // A snapshot is independent evidence. Append its view without consuming prose.
    discovery.candidates.push({id:block.id,start:text.length,end:text.length+1,format:'snapshot',block,source:'',sourceRef:{kind:'snapshot',id:snapshot.id},fidelity:{level:'exact',losses:[]}});
  }
  // exploreVariants (set by the semantic selector) offers every valid chart/plot view of a table, so a
  // model can choose by meaning; locally only the view matching the resolved task is generated.
  if(!veto&&['auto','markdown'].includes(options.inputFormat??'auto')) {
    // Explicit ordered lists (and dated schedules) read as steps in any task; unordered
    // bullet runs become checklists only when the user is planning.
    const plan=context.tasks.includes('plan');
    for(const c of planningLists(text))if((plan||c.block.type!=='checklist')&&!discovery.candidates.some(x=>x.start<c.end&&c.start<x.end))discovery.candidates.push(c);
    // Implicit structure in prose: verbatim and grounded by construction. Prose candidates may
    // overlap each other (the selector keeps at most one) but never an explicit structure.
    if(options.implicit!==false){
      const explicit=[...discovery.candidates];
      const derive=options.context?.style==='sketch'||options.context?.intent==='derive'||context.taskSource==='explicit'&&['explain','review'].includes(context.task);
      for(const c of discoverProseStructures(text,{instruction:presentationConstraints(options.context??{}).instruction,tasks:context.tasks,derive}))
        if(!explicit.some(x=>x.start<c.end&&c.start<x.end))discovery.candidates.push(c);
    }
  }
  // Proposals (e.g. from createAIAssist) are re-validated and re-grounded here: compileMessage is
  // public, so this option must never become a way to inject unverified data.
  if(!veto&&Array.isArray(options.groundedProposals))for(const p of options.groundedProposals.slice(0,4)){
    try{
      if(!Number.isInteger(p.start)||!Number.isInteger(p.end)||p.start<0||p.end>text.length||p.end-p.start<2)continue;
      const block=validateProposalBlock({...p.block,id:p.id});
      if(groundingViolations(block,text.slice(p.start,p.end)).length)continue;
      discovery.candidates.push({id:p.id,block,format:'ai-proposal',placement:p.placement==='replace'?'replace':'after',start:p.start,end:p.end,source:text.slice(p.start,p.end),sourceRef:{kind:'text',start:p.start,end:p.end},fidelity:{level:'exact',losses:[]}});
    }catch{}
  }
  const alternatives=c=>{const views=[tableTimeline(c)].filter(Boolean);if(!options.exploreVariants){const alt=plotAlternative(c,context.task==='auto'&&temporalTable(c)?'trend':context.task,options.context);return alt?[alt,...views]:views;}const out=new Map();for(const t of VARIANT_TASKS){const alt=plotAlternative(c,t,options.context);if(alt&&!out.has(candidateKey(alt)))out.set(candidateKey(alt),{...alt,explored:t!==context.task});}return [...out.values(),...views];};
  const ranked=discovery.candidates.flatMap(c=>[c,...alternatives(c)]).map(c=>({...c,...(isImplicitCandidate(c)?scoreImplicit(c,context,options.preferences):score(c,context,options.preferences))})).sort((a,b)=>b.score-a.score||a.start-b.start);
  return choosePresentation({candidates:ranked,diagnostics:discovery.diagnostics,policy,context,cap,veto,structuredParts:discovery.candidates.length,placement:normalizePlacement(options.placement)},options.selectionKeys);
}
/** Apply a view selection to the already parsed, validated candidates. No re-parsing. */
export function choosePresentation(prepared,selectionKeys) {
  const {candidates:ranked,policy,context,cap,veto}=prepared;
  const eligible=[],rejected=[];
  for(const c of ranked){
    let why=veto;
    const key=candidateKey(c),modelChosen=!!selectionKeys&&(selectionKeys.includes(key)||c.block.type==='plot'&&selectionKeys.includes(`${c.id}:plot`));
    if(!why&&selectionKeys&&!modelChosen)why='可选语义选择器没有选择此候选';
    if(!why&&(!cap.components.includes(c.block.type)||!context.allowedComponents.includes(c.block.type)))why='宿主未启用该组件';
    if(!why&&!modelChosen&&policy.mode!=='always'&&c.score<policy.minScore)why='净展示收益不足，保持原样';
    if(why)rejected.push({...c,reasons:[...c.reasons,why]});else eligible.push(c);
  }
  // Weighted interval selection: compare complete sets, so an early costly chart cannot
  // consume the budget needed by two more useful independent fragments. At most 8*24*N states.
  const ordered=[...eligible].sort((a,b)=>a.end-b.end||a.start-b.start||b.score-a.score);
  const previous=ordered.map((c,i)=>{let lo=0,hi=i-1,found=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(ordered[mid].end<=c.start){found=mid;lo=mid+1;}else hi=mid-1;}return found;});
  const count=Math.min(policy.maxEnhancements,cap.maxInteractiveBlocks),budget=Math.floor(policy.maxVisualCost),width=budget+1;
  const empty={items:[],value:0,cost:0},dp=[Array((count+1)*width).fill(empty)];
  // Iterative states avoid a call-stack limit on long, valid multi-fragment answers.
  for(let i=0;i<ordered.length;i++){
    const c=ordered[i],prior=dp[i],compatible=dp[previous[i]+1],row=[...prior];
    for(let n=1;n<=count;n++)for(let b=c.visualCost;b<=budget;b++){
      const at=n*width+b,rest=compatible[(n-1)*width+b-c.visualCost],value=rest.value+c.score,cost=rest.cost+c.visualCost,current=row[at];
      if(value>current.value+1e-9||Math.abs(value-current.value)<1e-9&&cost<current.cost)row[at]={items:[...rest.items,c],value,cost};
    }
    dp.push(row);
  }
  const choice=dp[ordered.length][count*width+budget];
  const selected=choice.items,spent=choice.cost;
  for(const c of eligible)if(!selected.includes(c))rejected.push({...c,reasons:[...c.reasons,selected.some(x=>x.start<c.end&&c.start<x.end)?'同一内容只选择一种主要呈现，避免重复':'展示预算不足']});
  const summary=c=>({id:c.id,key:candidateKey(c),type:c.block.type,format:c.format,start:c.start,end:c.end,score:c.score,visualCost:c.visualCost,reasons:c.reasons,quality:qualityNotes(c),fidelity:c.fidelity??{level:'exact',losses:[]},sourceRef:c.sourceRef??{kind:'text',start:c.start,end:c.end},...(c.projection?{projection:c.projection}:{}),...(c.placement==='after'?{placement:'after',display:replacesSource(c,prepared.placement)?'replace':'append',...(replacesSource(c,prepared.placement)?{reasons:c.reasons.map(r=>r===SUPPLEMENTARY_NOTE?'组件替代原句显示，逐字原文可展开查看':r)}:{})}:{})});
  const uncertain=ranked.filter(c=>context.allowedComponents.includes(c.block.type)&&cap.components.includes(c.block.type)&&c.visualCost<=policy.maxVisualCost&&Math.abs(c.score-policy.minScore)<=0.08);
  const assessment={tasks:context.tasks,taskSource:context.taskSource,structuredParts:prepared.structuredParts,
    needsReview:!veto&&(context.tasks.length>1||uncertain.length>0||context.task==='auto'&&ranked.some(c=>c.variant)),
    qualityWarnings:[...new Set(ranked.flatMap(c=>[...qualityNotes(c),...(c.fidelity?.losses??[])]))],
    reviewReasons:[...(context.tasks.length>1?['问题包含多个任务，需要权衡主视图']:[]),...(uncertain.length?['部分候选接近收益阈值']:[]),...(context.task==='auto'&&ranked.some(c=>c.variant)?['有多种可靠视图，但任务尚不明确']:[])]};
  const plan={assessment,alternatives:ranked.filter(c=>!selected.includes(c)&&context.allowedComponents.includes(c.block.type)&&cap.components.includes(c.block.type)&&c.visualCost<=policy.maxVisualCost).map(summary),policyVersion:POLICY_VERSION,state:veto?'text':policy.mode==='suggest'&&selected.length?'suggest':selected.length?'enhance':'text',reason:veto??(selectionKeys?.length===0?'显式选择保持原文':selected.length?'选择最小充分呈现':(!rejected.length&&prepared.diagnostics.find(d=>['FORMAT_FALLBACK','UNIT_CONFLICT'].includes(d.code))?.message)||'没有足够收益或可靠结构，保留原文'),task:context.task,selected:selected.sort((a,b)=>a.start-b.start).map(summary),rejected:rejected.map(summary),visualCost:spent,extraModelCalls:0,scoreMeaning:'未校准的规则评分，不是概率或已测学习收益'};
  return {...prepared,selected,plan};
}
export function planPresentation(text,options={}) {return preparePresentation(text,options).plan;}
export function composeAdaptive(text,{id='message',title='回答',sources=[],...options}={}) {
  return composePrepared(text,preparePresentation(text,options),{id,title,sources,...options});
}
export function composePrepared(text,prepared,{id='message',title='回答',sources=[],...options}={}) {
  const {plan}=prepared;
  if(plan.state!=='enhance')return {document:validateDocument(plainDocument(text,id,title,{format:options.format??'markdown'}),{sources}),plan,diagnostics:prepared.diagnostics};
  const blocks=[];let at=0,segment=0;
  const prose=body=>{if(!body)return;for(const part of splitText(body))blocks.push({id:`raw_${segment++}`,type:'prose',body:part,format:'markdown'});};
  for(const c of prepared.selected){if(replacesSource(c,prepared.placement)){prose(text.slice(at,c.start));blocks.push({...c.block,original:text.slice(c.start,c.end)});at=c.end;continue;}if(c.placement==='after'){prose(text.slice(at,c.end));blocks.push(c.block);at=c.end;continue;}prose(text.slice(at,c.start));blocks.push(c.block);if(c.fidelity?.level==='lossy')prose(text.slice(c.start,c.end));at=c.sourceRef?.kind==='snapshot'?c.start:c.end;}prose(text.slice(at));
  if(blocks.length>40)return {document:plainDocument(text,id,title,{format:'markdown'}),plan:{...plan,state:'text',selected:[],reason:'内容块预算不足，完整保留原文'},diagnostics:prepared.diagnostics};
  const losses=prepared.selected.flatMap(c=>c.fidelity?.losses??[]);
  return {document:validateDocument({warnings:[...new Set(losses)].slice(0,16),schemaVersion:SCHEMA_VERSION,id,revision:1,title,blocks,originalText:text},{sources}),plan,diagnostics:prepared.diagnostics};
}
/** Explicit feedback only. No dwell-time/surveillance proxy, no hidden persistence or network. */
/**
 * `initial` restores a previous `snapshot()` (invalid entries are skipped, never thrown), and
 * `onChange(snapshot)` lets the host persist explicit feedback itself. Nothing is stored here.
 */
export function createPreferenceStore({maxEntries=64,initial,onChange}={}) {
  requireContract(Number.isInteger(maxEntries)&&maxEntries>=1&&maxEntries<=256,'PREFERENCES','Invalid store limit');
  requireContract(onChange===undefined||typeof onChange==='function','PREFERENCES','onChange must be a function');
  const counts=new Map();
  const snapshot=()=>Object.fromEntries([...counts].map(([k,v])=>[k,{...v}]));
  const notify=()=>{if(!onChange)return;try{const r=onChange(snapshot());if(r&&typeof r.then==='function')Promise.resolve(r).catch(()=>{});}catch{}};
  if(initial&&typeof initial==='object'&&!Array.isArray(initial)){
    for(const [key,value] of Object.entries(initial)){
      const [task,component]=key.split(':');
      const ok=n=>Number.isInteger(n)&&n>=0&&n<=100;
      if(!TASKS.includes(task)||!Object.hasOwn(CATALOG,component??'')||!value||!ok(value.positive)||!ok(value.negative))continue;
      counts.set(`${task}:${component}`,{positive:value.positive,negative:value.negative});
      if(counts.size>maxEntries)counts.delete(counts.keys().next().value);
    }
  }
  return Object.freeze({
    record({component,task='auto',helpful}){requireContract(Object.hasOwn(CATALOG,component)&&TASKS.includes(task)&&typeof helpful==='boolean','PREFERENCES','Invalid explicit feedback');const key=`${task}:${component}`;const old=counts.get(key)??{positive:0,negative:0};if(helpful)old.positive++;else old.negative++;if(old.positive+old.negative>100){old.positive=Math.ceil(old.positive/2);old.negative=Math.ceil(old.negative/2);}counts.delete(key);counts.set(key,old);if(counts.size>maxEntries)counts.delete(counts.keys().next().value);notify();},
    adjustment(component,task='auto'){const c=counts.get(`${task}:${component}`);if(!c||c.positive+c.negative<2)return 0;return Math.max(-0.15,Math.min(0.1,(c.positive-c.negative)/(c.positive+c.negative+4)*0.2));},
    snapshot,
    reset:()=>{counts.clear();notify();}
  });
}

/** Provenance is supplied by the host, never accepted from message.presentation. */
export function prepareAuthored(document,options={}) {
  const context=resolveContext(options.context),cap=negotiateCapabilities(options.capabilities);
  const authoredBy=options.authoredBy??'model';
  requireContract(['model','host','user'].includes(authoredBy),'PROVENANCE','Invalid authoredBy');
  // Trusted host/user views may use their own count budget; hard constraints remain shared.
  const policy=normalizePolicy({...(['host','user'].includes(authoredBy)?{maxEnhancements:8,maxVisualCost:24}:{}),...options.policy});
  const veto=context.noUI||context.exact||options.mode==='text'?'用户要求文字或原样输出':policy.mode==='off'?'自动增强已关闭':!cap.rich||!cap.maxInteractiveBlocks?'宿主不支持增强':null;
  const candidates=document.blocks.flatMap((block,i)=>block.type==='prose'?[]:[{
    id:block.id,start:i,end:i+1,format:'authored',block,source:'',sourceRef:{kind:'authored',blockId:block.id},
    // Validation does not prove correspondence between model-authored values and prose.
    fidelity:{level:authoredBy==='model'?'lossy':'exact',losses:authoredBy==='model'?['模型提供的组件仅通过结构校验，与正文的事实对应尚未核验']:[]},
    ...score({block,format:'authored'},context,options.preferences),
    ...(authoredBy==='model'?{}:{score:1,reasons:['用户或可信宿主已指定该视图；仍遵守公共硬约束']})
  }]);
  return choosePresentation({candidates,diagnostics:[],policy,context,cap,veto,structuredParts:candidates.length,authoredBy},options.selectionKeys);
}
