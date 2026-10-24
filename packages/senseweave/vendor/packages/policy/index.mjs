import {planningLists} from './lists.mjs';
import {dataProfile, qualityNotes} from './evidence.mjs';
/** Local-first presentation decisions. Scores are design heuristics, NOT probabilities or
 * measured learning gains. Data availability and user control are hard gates before scoring.
 */
import {discoverFormats} from '../formats/index.mjs';
import {validateDocument,plainDocument,splitText,SCHEMA_VERSION,requireContract,cleanText,CATALOG} from '../core/document.mjs';
import {negotiateCapabilities} from '../runtime/capabilities.mjs';
export const POLICY_VERSION='0.5-local-2';
export const DEFAULT_POLICY=Object.freeze({mode:'auto',maxEnhancements:2,maxVisualCost:4,minScore:0.68});
const TASKS=['auto','lookup','compare','trend','relation','explain','review','inspect','plan'];
const COST={table:1,plot:3,chart:2,diagram:2,json:1,diff:1,math:1,details:1};
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
  const noUI=preference==='text'||/(?:只要|只用|仅用|纯)\s*(?:文字|文本)|不要.{0,6}(?:图表|图形|界面|可视化|动画)|\b(?:plain text only|no (?:charts?|visuals?|ui)|text only)\b/i.test(prompt);
  const exact=task==='lookup'||/(?:逐字|原样|不要改写|仅翻译|只翻译)|\b(?:verbatim|translate only|exact output|do not reformat)\b/i.test(prompt);
  const rules=[['trend',/趋势|走势|随时间|时间序列|\b(?:trend|over time|time series)\b/i],['compare',/比较|对比|优缺点|区别|差异|\b(?:compare|versus|vs)\b/i],['relation',/相关性|散点|两个变量|\b(?:correlation|scatter)\b/i],['inspect',/检查|查看数据|查找|检索|排序|调试|\b(?:inspect|search|sort|debug)\b/i],['review',/复习|\breview\b/i],['explain',/解释|理解|讲解|原理|\bexplain\b/i],['plan',/计划|清单|\bplan\b/i]];
  const matched=rules.filter(([,r])=>r.test(prompt)).map(([name])=>name);
  const tasks=task==='auto'?(matched.length?matched:['auto']):[task];
  return {task:tasks[0],tasks,taskSource:task==='auto'?(matched.length?'prompt':'unspecified'):'explicit',
    preference,viewport:context.viewport??'wide',reducedMotion:context.reducedMotion===true,screenReader:context.screenReader===true,sensitive:context.sensitive===true,noUI,exact};
}
/** Stable selection key; line and scatter views of one table are different choices. */
export function candidateKey(c) {const b=c.block??c;return b.type==='plot'?`${c.id}:plot:${b.data.kind}`:`${c.id}:${b.type}`;}
const VARIANT_TASKS=['compare','trend','relation'];
function plotAlternative(candidate,task) {
  if(candidate.block.type!=='table')return null;
  const {columns,rows}=candidate.block.data;
  if(rows.length<3)return null;
  const y=columns.map((c,i)=>({c,i})).filter(x=>x.c.kind==='quantitative'&&x.c.unit&&x.c.unit!=='未声明');
  if(y.length!==1)return null; // Do not choose a measure by guessing between alternatives.
  const {c:yc,i:yi}=y[0];
  const xs=columns.map((c,i)=>({c,i})).filter(x=>x.i!==yi);
  if(xs.length!==1)return null;
  const {c:xc,i:xi}=xs[0];let block;
  if(task==='compare'&&new Set(rows.map(r=>r[xi])).size===rows.length&&xc.kind==='nominal'&&rows.length<=20&&rows.every(r=>typeof r[xi]==='string'&&typeof r[yi]==='number'))block={type:'chart',data:{unit:yc.unit,rows:rows.map(r=>({label:r[xi],value:r[yi]})),note:'由原表逐行映射，未生成、补齐或汇总新数据。'}};
  else if((task==='trend'&&['temporal','ordinal','quantitative'].includes(xc.kind))||(task==='inspect'&&['temporal','ordinal'].includes(xc.kind)&&rows.length>=4)||(task==='relation'&&xc.kind==='quantitative'))block={type:'plot',data:{kind:task==='relation'?'scatter':'line',xKind:xc.kind,xLabel:xc.label,yLabel:yc.label,yUnit:yc.unit,points:rows.map(r=>({x:r[xi],y:r[yi]}))}};
  if(!block)return null;
  try {block.id=candidate.id;const v=validateDocument({schemaVersion:SCHEMA_VERSION,id:'probe',revision:1,title:'',blocks:[block]}).blocks[0];return {...candidate,block:v,variant:true};}catch{return null;}
}
function score(candidate,ctx,preferences) {
  const b=candidate.block,type=b.type,reasons=['已识别完整结构，组件数据可由原文直接获得'];
  let value=0.74;
  if(type==='table'){
    const r=b.data.rows.length,c=b.data.columns.length;
    value=candidate.format==='markdown-table'?0.54:0.74;
    if(r>=5||c>=4){value+=0.16;reasons.push('行列规模使本地筛选/排序有价值');}
    if(['inspect','compare'].includes(ctx.task)){value+=0.16;reasons.push('当前任务需要查找或比较');}
    if(ctx.viewport==='compact'&&c>4){value-=0.16;reasons.push('窄屏宽表增加阅读负担');}
    if(r<=2&&c<=2){value-=0.08;reasons.push('小表格通常不需要额外交互');}
  }
  if(type==='checklist'||type==='steps'){value=0.88;reasons.push(type==='checklist'?'计划任务中的显式条目可逐项核对；勾选仅为本页状态':'原文有明确编号顺序，保留每一项，不推断新步骤');}
  if(type==='json'){value=0.64+(JSON.stringify(b.data.value).length>=100?0.12:0)+(ctx.task==='inspect'?0.12:0);reasons.push('树状折叠只用于结构检查，不执行对象内容');}
  if(type==='math'){value=0.78;reasons.push('受限公式可无模型编译为 MathML');}
  if(type==='diff'){value=0.8;reasons.push('保留每条差异，仅增强阅读，不应用补丁');}
  if(type==='diagram'){value=0.8;reasons.push('仅采用显式节点和边，不从自然语言猜关系');}
  if(candidate.variant&&candidate.explored){value=0.6;reasons.push('备选视图：轴语义与单位明确、无新增数值；是否更合适由语义选择器结合问题判断');}
  else if(candidate.variant){value=0.92;reasons.push('任务匹配，轴语义与单位明确，无新增数值');}
  if(ctx.preference==='visual'){value+=0.1;reasons.push('用户明确偏好增强展示');}
  if(ctx.screenReader&&['plot','chart','diagram'].includes(type)){value-=0.2;reasons.push('屏幕阅读器优先结构化文字/数据表');}
  const profile=dataProfile(b);
  if(candidate.variant && profile.constant){value-=0.24;reasons.push('数据没有数值变化，优先保留可核对的数据表');}
  if(candidate.variant && profile.missingRatio>=0.3){value-=0.14;reasons.push('缺失比例增加图形误读风险，优先数据核对');}
  if(candidate.variant && ctx.viewport==='compact' && profile.rows>10){value-=0.12;reasons.push('窄屏下较多数据点或分类需要更高的阅读成本');}
  const feedback=preferences?.adjustment?.(type,ctx.task)??0;
  if(feedback){value+=feedback;reasons.push('依据当前实例显式的有用/无用反馈保守调整');}
  return {score:Math.round(Math.max(0,Math.min(1,value))*1000)/1000,reasons,visualCost:COST[type]??1};
}
export function preparePresentation(text,options={}) {
  cleanText(text,60000);
  const policy=normalizePolicy(options.policy),context=resolveContext(options.context),cap=negotiateCapabilities(options.capabilities);
  let veto=null;
  if(context.noUI||context.exact||options.mode==='text')veto='用户要求文字或原样输出';
  else if(policy.mode==='off')veto='自动增强已关闭';
  else if(options.final===false)veto='流式正文先显示；完成后再一次性决策';
  else if(!cap.rich||!cap.maxInteractiveBlocks)veto='宿主不支持增强';
  // Hard refusal/streaming/unsupported host: avoid format parsing entirely.
  const discovery=veto?{candidates:[],diagnostics:[]}:discoverFormats(text,{inputFormat:options.inputFormat,columns:options.columns,final:options.final!==false});
  // exploreVariants (set by the semantic selector) offers every valid chart/plot view of a table, so a
  // model can choose by meaning; locally only the view matching the resolved task is generated.
  if(!veto&&context.tasks.includes('plan')&&['auto','markdown'].includes(options.inputFormat??'auto')) {
    for(const c of planningLists(text))if(!discovery.candidates.some(x=>x.start<c.end&&c.start<x.end))discovery.candidates.push(c);
  }
  const alternatives=c=>{if(!options.exploreVariants){const alt=plotAlternative(c,context.task);return alt?[alt]:[];}const out=new Map();for(const t of VARIANT_TASKS){const alt=plotAlternative(c,t);if(alt&&!out.has(candidateKey(alt)))out.set(candidateKey(alt),{...alt,explored:t!==context.task});}return [...out.values()];};
  const ranked=discovery.candidates.flatMap(c=>[c,...alternatives(c)]).map(c=>({...c,...score(c,context,options.preferences)})).sort((a,b)=>b.score-a.score||a.start-b.start);
  const eligible=[],rejected=[];
  for(const c of ranked){
    let why=veto;
    const key=candidateKey(c),modelChosen=!!options.selectionKeys&&(options.selectionKeys.includes(key)||c.block.type==='plot'&&options.selectionKeys.includes(`${c.id}:plot`));
    if(!why&&options.selectionKeys&&!modelChosen)why='可选语义选择器没有选择此候选';
    if(!why&&!cap.components.includes(c.block.type))why='宿主未启用该组件';
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
  const summary=c=>({id:c.id,key:candidateKey(c),type:c.block.type,format:c.format,start:c.start,end:c.end,score:c.score,visualCost:c.visualCost,reasons:c.reasons,quality:qualityNotes(c)});
  const uncertain=ranked.filter(c=>cap.components.includes(c.block.type)&&c.visualCost<=policy.maxVisualCost&&Math.abs(c.score-policy.minScore)<=0.08);
  const assessment={tasks:context.tasks,taskSource:context.taskSource,structuredParts:discovery.candidates.length,
    needsReview:!veto&&(context.tasks.length>1||uncertain.length>0||context.task==='auto'&&ranked.some(c=>c.variant)),
    qualityWarnings:[...new Set(ranked.flatMap(qualityNotes))],
    reviewReasons:[...(context.tasks.length>1?['问题包含多个任务，需要权衡主视图']:[]),...(uncertain.length?['部分候选接近收益阈值']:[]),...(context.task==='auto'&&ranked.some(c=>c.variant)?['有多种可靠视图，但任务尚不明确']:[])]};
  const plan={assessment,alternatives:ranked.filter(c=>!selected.includes(c)&&cap.components.includes(c.block.type)&&c.visualCost<=policy.maxVisualCost).map(summary),policyVersion:POLICY_VERSION,state:veto?'text':policy.mode==='suggest'&&selected.length?'suggest':selected.length?'enhance':'text',reason:veto??(options.selectionKeys?.length===0?'显式选择保持原文':selected.length?'选择最小充分呈现':(!rejected.length&&discovery.diagnostics.find(d=>d.code==='FORMAT_FALLBACK')?.message)||'没有足够收益或可靠结构，保留原文'),task:context.task,selected:selected.sort((a,b)=>a.start-b.start).map(summary),rejected:rejected.map(summary),visualCost:spent,extraModelCalls:0,scoreMeaning:'未校准的规则评分，不是概率或已测学习收益'};
  return {selected,plan,diagnostics:discovery.diagnostics,policy,context,candidates:ranked};
}
export function planPresentation(text,options={}) {return preparePresentation(text,options).plan;}
export function composeAdaptive(text,{id='message',title='回答',sources=[],...options}={}) {
  const prepared=preparePresentation(text,options),{plan}=prepared;
  if(plan.state!=='enhance')return {document:validateDocument(plainDocument(text,id,title,{format:options.format??'markdown'}),{sources}),plan,diagnostics:prepared.diagnostics};
  const blocks=[];let at=0,segment=0;
  const prose=body=>{if(!body)return;for(const part of splitText(body))blocks.push({id:`raw_${segment++}`,type:'prose',body:part,format:'markdown'});};
  for(const c of prepared.selected){prose(text.slice(at,c.start));blocks.push(c.block);at=c.end;}prose(text.slice(at));
  if(blocks.length>40)return {document:plainDocument(text,id,title,{format:'markdown'}),plan:{...plan,state:'text',selected:[],reason:'内容块预算不足，完整保留原文'},diagnostics:prepared.diagnostics};
  return {document:validateDocument({schemaVersion:SCHEMA_VERSION,id,revision:1,title,blocks,originalText:text},{sources}),plan,diagnostics:prepared.diagnostics};
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
