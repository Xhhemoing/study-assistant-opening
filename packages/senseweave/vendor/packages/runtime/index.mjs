import {composeText} from '../core/compose.mjs';
import {extractText} from '../core/adapters.mjs';
import {validateDocument, normalizeSources, plainDocument, projectText, validId, cleanText, requireContract} from '../core/document.mjs';
import {negotiateCapabilities, applyCapabilities, RUNTIME_VERSION} from './capabilities.mjs';
import {createInstructions} from './instructions.mjs';
import {normalizePolicy, resolveContext, createPreferenceStore, planPresentation, POLICY_VERSION} from '../policy/index.mjs';
import {createViewPlan} from './view-plan.mjs';
import {preparePresentation,prepareAuthored,choosePresentation,composePrepared,candidateKey,normalizePlacement} from '../policy/index.mjs';
import {discoverFormats} from '../formats/index.mjs';
import {planPresentationStyle} from '../policy/motion.mjs';
// An authored `original` must be a verbatim span of this answer; anything else is dropped.
const verbatimOriginals=(blocks,content)=>Array.isArray(blocks)?blocks.map(b=>b&&typeof b==='object'&&b.original!==undefined&&!(typeof b.original==='string'&&b.original&&content.includes(b.original))?(({original,...rest})=>rest)(b):b):blocks;
/** Lossless envelope. Failure of presentation must not become failure of the assistant's answer. */
export function compileMessage(message, options = {}) {return prepareOutput(message,options,false).local;}
/** Parse once; later selections can only reference this private validated snapshot. */
export function prepareMessage(message, options = {}) {return prepareOutput(message,options,true);}
function prepareOutput(message,options,reusable) {
  options={...options,rawCapabilities:options.rawCapabilities??{motion:options.capabilities?.motion,sketch:options.capabilities?.sketch},context:structuredClone(options.context??{}),policy:{...options.policy},...(options.dataSnapshot?{dataSnapshot:structuredClone(options.dataSnapshot)}:{})};
  requireContract(message && typeof message === 'object', 'MESSAGE', 'Expected a message object');
  const sources = normalizeSources(options.sources ?? []);
  const capabilities = negotiateCapabilities(options.capabilities);
  const content = cleanText(extractText(message), 60000);
  const messageId = message.id ?? 'message';
  validId(messageId);
  const title = cleanText(options.title ?? message.title ?? '回答', 200);
  const mode = options.mode ?? 'auto';
  requireContract(['auto', 'text', 'rich'].includes(mode), 'MODE', 'mode must be auto, text or rich');
  normalizePlacement(options.placement);
  normalizePolicy(options.policy);
  const context = resolveContext(options.context);
  const forceText = mode === 'text' || context.noUI || context.exact;
  const diagnostics = [];
  let decision = null;
  let doc, authoredDocument=null, prepared=null, pending = null, downgraded = 0;
  let readable=content;
  if(!readable&&message.presentation){try{readable=projectText(validateDocument(message.presentation,{sources}),{includeOriginal:false});}catch{}}
  let snapshotText='',snapshotId='',dataSnapshots=[];
  if(options.dataSnapshot){
    const snapshot=options.dataSnapshot;validId(snapshot.id);snapshotId='snapshot_'+snapshot.id;
    const fallback=validateDocument({schemaVersion:'0.2',id:messageId,revision:1,title:'',blocks:[{id:snapshotId,type:'table',data:{columns:snapshot.columns,rows:snapshot.rows}}]});
    dataSnapshots=[{id:snapshot.id,...fallback.blocks[0].data}];
    snapshotText=projectText(fallback,{includeOriginal:false});
    readable=cleanText(readable+'\n\n'+snapshotText,60000);
  }
  const plain = () => validateDocument({...plainDocument(readable, messageId, title, {format: options.format ?? 'markdown'}),originalText:content}, {sources});
  try {
    if (forceText) doc = plain();
    else if (message.presentation) doc = validateDocument({...message.presentation, id: messageId, originalText: content || message.presentation.originalText || '', blocks: verbatimOriginals(message.presentation.blocks, content)}, {sources});
    else if (mode === 'rich' || /(?:^|\n) {0,3}`{3,}\s*sw:/.test(content)) {
      const composed = composeText(content, {id: messageId, title, sources, final: options.final !== false});
      doc = composed.document;
      pending = composed.pending;
    } else {
      prepared=preparePresentation(content,{...options,capabilities});
      const adapted = composePrepared(content,prepared, {...options, id: messageId, title, sources, capabilities});
      doc = adapted.document; decision = adapted.plan; diagnostics.push(...adapted.diagnostics);
    }
    if(!forceText&&!prepared){
      authoredDocument=doc;
      prepared=prepareAuthored(doc,{...options,capabilities});
      const selected=prepared.plan.state==='suggest'?new Set():new Set(prepared.selected.map(c=>c.id));
      const adapted=applyCapabilities(doc,capabilities,sources,{partial:options.final===false,disabledIds:prepared.candidates.filter(c=>!selected.has(c.id)).map(c=>c.id)});
      doc=adapted.document;downgraded+=adapted.downgraded;
      decision={...prepared.plan,state:doc.blocks.some(b=>b.type!=='prose')?'authored':prepared.plan.state==='suggest'?'suggest':'text'};
    }
    if (options.final !== false || !capabilities.rich || options.capabilities) {
      const adapted = applyCapabilities(doc, capabilities, sources, {partial: options.final === false});
      doc = adapted.document;
      downgraded += adapted.downgraded;
    }
    if (downgraded) diagnostics.push({code: 'CAPABILITY_DOWNGRADE', severity: 'info', message: `${downgraded} 个组件已转为可读文字。`});
  } catch (error) {
    doc = plain();
    prepared=null;authoredDocument=null;
    pending = null;
    diagnostics.push({code: 'PRESENTATION_FALLBACK', severity: 'warning', message: `增强不可用（${typeof error.code === 'string' ? error.code : 'INVALID'}）；原文完整保留。`});
    doc.warnings.push(diagnostics.at(-1).message);
  }
  if (message.revision !== undefined) {
    requireContract(Number.isSafeInteger(message.revision) && message.revision > 0, 'REVISION', 'Expected positive message revision');
    doc.revision = message.revision;
    delete doc.baseRevision;
  }
  if (!decision) decision = {policyVersion:POLICY_VERSION, state:forceText?'text':doc.blocks.some(b=>b.type!=='prose')?'authored':'text', reason:forceText?'用户要求文字或原样输出':'显式组件由上游提供，仍受校验与宿主能力限制', selected:[], rejected:[], extraModelCalls:0};
  const envelope={dataSnapshots,version: '0.5', runtimeVersion: RUNTIME_VERSION, messageId, content, document: doc,
    text: forceText ? readable : projectText(doc, {includeOriginal: false}),
    decision, mode: !forceText && capabilities.rich && doc.blocks.some(b => b.type !== 'prose') ? 'rich' : 'text', pending, diagnostics};
  const finish=value=>{
    let document=value.document;
    const snapshotShown=value.decision.selected.some(c=>c.sourceRef?.kind==='snapshot'&&c.sourceRef.id===options.dataSnapshot?.id&&document.blocks.some(b=>b.id===c.id));
    if(snapshotText&&!forceText&&!snapshotShown&&!document.blocks.filter(b=>b.type==='prose').map(b=>b.body).join('').includes(snapshotText)){
      const ids=new Set(document.blocks.map(b=>b.id));
      const blocks=plainDocument(snapshotText,messageId,title,{format:'text'}).blocks.map((b,i)=>{let id=`snapshot_fallback_${i}`;while(ids.has(id))id+='x';ids.add(id);return {...b,id};});
      document=document.blocks.length+blocks.length<=40?validateDocument({...document,blocks:[...document.blocks,...blocks]},{sources,partial:options.final===false}):plain();
      document.revision=value.document.revision;
    }
    const rich=capabilities.rich&&document.blocks.some(b=>b.type!=='prose');
    const decision=!rich&&['enhance','authored'].includes(value.decision.state)?{...value.decision,state:'text',selected:[],visualCost:0}:value.decision;
    // Motion/sketch hints are inert decoration metadata; failure here never affects the answer.
    let hints;
    try{hints=planPresentationStyle(document,{context:options.context,resolved:context,final:options.final!==false,capabilities:options.rawCapabilities??{},suggestion:options.presentationSuggestion??null,mode:rich?'rich':'text'});}
    catch{hints={motion:{enabled:false,reason:'展示风格配置无效，按无动画显示',blocks:{}},sketch:{enabled:false,reason:'展示风格配置无效',blocks:[]},annotations:[],rejected:[]};}
    hints.documentId=document.id;
    const presentation={motion:hints.motion.enabled?Object.fromEntries(Object.entries(hints.motion.blocks).filter(([,v])=>v.preset!=='none').map(([k,v])=>[k,v.preset])):{},motionReason:hints.motion.reason,sketch:hints.sketch.enabled,sketchBlocks:hints.sketch.blocks,sketchReason:hints.sketch.reason,annotations:hints.annotations.length};
    return {...value,document,decision:{...decision,presentation},hints,mode:rich?'rich':'text',text:forceText?readable:projectText(document,{includeOriginal:false}),viewPlan:createViewPlan(messageId,document.revision,decision)};
  };
  const local=finish(envelope);
  return Object.freeze({local:reusable?structuredClone(local):local,
    // Public copies cannot modify the private candidate data used by choose().
    prepared:reusable&&prepared?structuredClone({...prepared,cap:capabilities}):null,
    choose(keys){
      requireContract(prepared&&Array.isArray(keys)&&keys.every(k=>typeof k==='string'&&prepared.candidates.some(c=>candidateKey(c)===k))&&new Set(keys).size===keys.length,'VIEW_PLAN','Unknown or duplicate view key');
      const next=choosePresentation(prepared,keys);
      requireContract(next.selected.length===keys.length,'VIEW_PLAN','Selection violates hard constraints, overlap or budgets');
      if(authoredDocument){
        const selected=new Set(next.selected.map(c=>c.id));
        const adapted=applyCapabilities(authoredDocument,capabilities,sources,{partial:options.final===false,disabledIds:prepared.candidates.filter(c=>!selected.has(c.id)).map(c=>c.id)});
        const document=adapted.document,rich=document.blocks.some(b=>b.type!=='prose');
        if(message.revision!==undefined)document.revision=message.revision;
        const decision={...next.plan,state:rich?'authored':'text'};
        return structuredClone(finish({...envelope,document,text:projectText(document,{includeOriginal:false}),mode:rich?'rich':'text',decision}));
      }
      const adapted=composePrepared(content,next,{...options,id:messageId,title,sources});
      if(message.revision!==undefined)adapted.document.revision=message.revision;
      return structuredClone(finish({...envelope,document:adapted.document,decision:adapted.plan,text:projectText(adapted.document,{includeOriginal:false}),mode:adapted.plan.state==='enhance'?'rich':'text'}));
    }
  });
}
/** Instance-scoped configuration; no shared globals, network calls or execution permissions. */
export function createSenseWeave(options = {}) {
  const preferences = options.preferences ?? createPreferenceStore();
  normalizePolicy(options.policy);
  const config = {...options, rawCapabilities: {motion: options.capabilities?.motion, sketch: options.capabilities?.sketch}, policy: {...options.policy}, context: {...options.context}, sources: normalizeSources(options.sources ?? []), capabilities: negotiateCapabilities(options.capabilities), preferences};
  const maxEntries = options.cache?.maxEntries ?? 16, maxChars = options.cache?.maxChars ?? 800000;
  requireContract(Number.isInteger(maxEntries)&&maxEntries>=0&&maxEntries<=128&&Number.isInteger(maxChars)&&maxChars>=0&&maxChars<=8000000,'CACHE','Invalid bounded cache');
  const cache=new Map();let size=0,hits=0,misses=0;
  const merged = override => ({...config,...override, context:{...config.context,...override?.context}, policy:{...config.policy,...override?.policy}, preferences});
  return Object.freeze({
    render(message, override = {}) {
      const opts=merged(override);
      // Instance-local and keyed by full content, host options and explicit preference state.
      const key=maxEntries && opts.final!==false ? JSON.stringify([message,opts,preferences.snapshot()]) : null;
      if(key && cache.has(key)){const e=cache.get(key);cache.delete(key);cache.set(key,e);hits++;return structuredClone(e.value);}
      misses++;const result=compileMessage(message,opts);
      // Only reusable successes are retained. A text fallback or any downgrade/fallback
      // diagnostic is keyed by content that is either still growing (streaming) or already
      // rejected, so it never hits; keeping it would evict entries that do get reused.
      const reusable=result.mode==='rich'&&Array.isArray(result.diagnostics)&&result.diagnostics.length===0;
      if(key&&reusable){const chars=key.length+JSON.stringify(result).length;if(chars<=maxChars){while(cache.size&&(cache.size>=maxEntries||size+chars>maxChars)){const first=cache.keys().next().value;size-=cache.get(first).chars;cache.delete(first);}cache.set(key,{value:structuredClone(result),chars});size+=chars;}}
      return result;
    },
    plan: (text, override = {}) => planPresentation(text, merged(override)),
    feedback(event){preferences.record(event);cache.clear();size=0;},
    resetPreferences(){preferences.reset();cache.clear();size=0;},
    getStats:()=>({cacheHits:hits,cacheMisses:misses,cacheEntries:cache.size,cacheChars:size,extraModelCalls:0}),
    clearCache(){cache.clear();size=0;},
    instructions: context => createInstructions({...context, capabilities: config.capabilities}),
    createSession: sessionOptions => createOutputSession({...merged(sessionOptions),preferences})
  });
}
/** Coalesce many token deltas into bounded rendering updates, with explicit finish/cancel/failure. */
export function createOutputSession({messageId = 'message', signal, onUpdate, onError, throttleMs = 32, assist, ...options} = {}) {
  validId(messageId);
  requireContract(Number.isFinite(throttleMs) && throttleMs >= 0 && throttleMs <= 1000, 'THROTTLE', 'throttleMs must be 0–1000');
  requireContract(signal === undefined || signal && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function', 'SIGNAL', 'Expected an AbortSignal');
  requireContract(onUpdate === undefined || typeof onUpdate === 'function', 'CALLBACK', 'onUpdate must be a function');
  requireContract(onError === undefined || typeof onError === 'function', 'CALLBACK', 'onError must be a function');
  requireContract(assist === undefined || assist === null || typeof assist?.progressive === 'function', 'ASSIST', 'assist must come from createAIAssist');
  // Reject host configuration before a stream owns input or schedules updates. Keep mutable
  // caller configuration out of later snapshots; the preference store remains live by design.
  requireContract(options.mode === undefined || ['auto', 'text', 'rich'].includes(options.mode), 'MODE', 'mode must be auto, text or rich');
  requireContract(options.format === undefined || ['text', 'markdown'].includes(options.format), 'FORMAT', 'format must be text or markdown');
  if (options.title !== undefined) cleanText(options.title, 200);
  resolveContext(options.context);
  discoverFormats('', {inputFormat: options.inputFormat, columns: options.columns, final: false});
  normalizePolicy(options.policy);
  options = {...options, policy: {...options.policy}, context: structuredClone(options.context??{}),
    ...(options.dataSnapshot?{dataSnapshot:structuredClone(options.dataSnapshot)}:{}),
    rawCapabilities: options.rawCapabilities ?? {motion: options.capabilities?.motion, sketch: options.capabilities?.sketch},
    capabilities: negotiateCapabilities(options.capabilities),
    ...(options.columns === undefined ? {} : {columns: structuredClone(options.columns)}),
    ...(Array.isArray(options.selectionKeys) ? {selectionKeys: [...options.selectionKeys]} : {})};
  const sources = normalizeSources(options.sources ?? []);
  const lifecycle = new AbortController();
  let compiledKey = '', compiled = null, compilations = 0, upgraded = null;
  let text = '', status = 'streaming', timer = null, disposed = false, chunks = 0, renders = 0, reason = '', revision = 1;
  const snapshot = () => {
    const key=`${revision}:${status}`;
    if (key !== compiledKey) {
      // Every terminal state must expose an unfinished authored fence as readable text.
      // A cancelled/failed ordinary data stream is not a complete dataset: keep automatic
      // discovery off while retaining explicitly authored, already closed components.
      const interrupted = status === 'cancelled' || status === 'failed';
      compiled=compileMessage({id:messageId,content:text,revision},{...options,sources,
        autoDiscover:!interrupted&&options.autoDiscover!==false,final:status!=='streaming'});
      compiledKey=key;compilations++;
    }
    if (upgraded && status === 'completed') return {status,reason,chunks,renders,compilations,aiUpgraded:true,...structuredClone(upgraded)};
    return {status,reason,chunks,renders,compilations,...structuredClone(compiled)};
  };
  const clear = () => {if (timer !== null) clearTimeout(timer); timer = null;};
  const reportError = error => {
    // Host observers must not turn a successful terminal commit into an upstream failure.
    try {const result=onError?.(error);if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});} catch {}
  };
  const notify = () => {
    clear();
    if (disposed) return;
    renders++;
    if (onUpdate) {try {const result=onUpdate(snapshot());if(result&&typeof result.then==='function')Promise.resolve(result).catch(reportError);} catch (error) {reportError(error);}}
  };
  const ensure = () => requireContract(!disposed && status === 'streaming', 'TERMINAL', 'Session is no longer streaming');
  const terminal = (next, why = '') => {
    ensure();
    status = next; reason = why; signal?.removeEventListener('abort', abort);
    lifecycle.abort();
    notify();
    const result = snapshot();
    // Optional AI upgrade after the stream completed: the local result is already shown; a
    // grounded model result arrives later as revision + 1. Any failure keeps the local result.
    if (next === 'completed' && assist && !disposed) {
      try {
        const {upgrade} = assist.progressive({id: messageId, content: text, revision}, {...options, sources, final: true});
        upgrade.then(env => {
          if (disposed || !env || env.document.revision <= revision) return;
          upgraded = env; renders++;
          if (onUpdate) {try {const r=onUpdate(snapshot());if(r&&typeof r.then==='function')Promise.resolve(r).catch(reportError);} catch (error) {reportError(error);}}
        }, reportError);
      } catch (error) {reportError(error);}
    }
    return result;
  };
  const abort = () => {if (!disposed && status === 'streaming') terminal('cancelled', '已取消；保留已收到的内容。');};
  if (signal?.aborted) {status = 'cancelled'; reason = '已取消；未接收新内容。'; lifecycle.abort();}
  else signal?.addEventListener('abort', abort, {once: true});
  return Object.freeze({
    // A close signal, not ownership of the host's fetch. Consumers may explicitly bind
    // their work to it; pipeProviderStream does so for the source handed to that function.
    signal: lifecycle.signal,
    push(delta) {
      ensure(); cleanText(delta, 60000);
      requireContract(text.length + delta.length <= 60000, 'BUDGET', 'Text budget exceeded; nothing was appended');
      if (!delta) return;
      text += delta; chunks++; revision++;
      if (timer === null) timer = setTimeout(notify, throttleMs);
    },
    finish: () => terminal('completed'),
    cancel: () => terminal('cancelled', '已取消；保留已收到的内容。'),
    fail: (message = '上游中断；保留已收到的内容。') => terminal('failed', cleanText(message, 1000)),
    flush: () => {ensure(); notify(); return snapshot();},
    getState: () => snapshot(),
    dispose() {
      clear(); signal?.removeEventListener('abort', abort);
      if (status === 'streaming') {status = 'cancelled'; reason = '会话已关闭；保留已收到的内容。';}
      disposed = true;
      lifecycle.abort();
    }
  });
}
