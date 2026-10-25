import {composeText} from '../core/compose.mjs';
import {extractText} from '../core/adapters.mjs';
import {validateDocument, normalizeSources, plainDocument, projectText, validId, cleanText, requireContract} from '../core/document.mjs';
import {negotiateCapabilities, applyCapabilities, RUNTIME_VERSION} from './capabilities.mjs';
import {createInstructions} from './instructions.mjs';
import {composeAdaptive, normalizePolicy, resolveContext, createPreferenceStore, planPresentation, POLICY_VERSION} from '../policy/index.mjs';
import {discoverFormats} from '../formats/index.mjs';
/** Lossless envelope. Failure of presentation must not become failure of the assistant's answer. */
export function compileMessage(message, options = {}) {
  requireContract(message && typeof message === 'object', 'MESSAGE', 'Expected a message object');
  const sources = normalizeSources(options.sources ?? []);
  const capabilities = negotiateCapabilities(options.capabilities);
  const content = cleanText(extractText(message), 60000);
  const messageId = message.id ?? 'message';
  validId(messageId);
  const title = cleanText(options.title ?? message.title ?? '回答', 200);
  const mode = options.mode ?? 'auto';
  requireContract(['auto', 'text', 'rich'].includes(mode), 'MODE', 'mode must be auto, text or rich');
  normalizePolicy(options.policy);
  const context = resolveContext(options.context);
  const forceText = mode === 'text' || context.noUI || context.exact;
  const diagnostics = [];
  let decision = null;
  let doc, pending = null, downgraded = 0;
  const plain = () => validateDocument(plainDocument(content, messageId, title, {format: options.format ?? 'markdown'}), {sources});
  try {
    if (forceText) doc = plain();
    else if (message.presentation) doc = validateDocument({...message.presentation, id: messageId, originalText: content || message.presentation.originalText || ''}, {sources});
    else if (mode === 'rich' || /(?:^|\n) {0,3}`{3,}\s*sw:/.test(content)) {
      const composed = composeText(content, {id: messageId, title, sources, final: options.final !== false});
      doc = composed.document;
      pending = composed.pending;
    } else {
      const adapted = composeAdaptive(content, {...options, id: messageId, title, sources, capabilities});
      doc = adapted.document; decision = adapted.plan; diagnostics.push(...adapted.diagnostics);
    }
    if (options.final !== false || !capabilities.rich || options.capabilities) {
      const adapted = applyCapabilities(doc, capabilities, sources, {partial: options.final === false});
      doc = adapted.document;
      downgraded = adapted.downgraded;
    }
    if (downgraded) diagnostics.push({code: 'CAPABILITY_DOWNGRADE', severity: 'info', message: `${downgraded} 个组件已转为可读文字。`});
  } catch (error) {
    doc = plain();
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
  return {version: '0.5', runtimeVersion: RUNTIME_VERSION, messageId, content, document: doc,
    text: forceText ? content : projectText(doc, {includeOriginal: false}),
    decision, mode: !forceText && capabilities.rich && doc.blocks.some(b => b.type !== 'prose') ? 'rich' : 'text', pending, diagnostics};
}
/** Instance-scoped configuration; no shared globals, network calls or execution permissions. */
export function createSenseWeave(options = {}) {
  const preferences = options.preferences ?? createPreferenceStore();
  const config = {...options, policy: normalizePolicy(options.policy), context: {...options.context}, sources: normalizeSources(options.sources ?? []), capabilities: negotiateCapabilities(options.capabilities), preferences};
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
export function createOutputSession({messageId = 'message', signal, onUpdate, onError, throttleMs = 32, ...options} = {}) {
  validId(messageId);
  requireContract(Number.isFinite(throttleMs) && throttleMs >= 0 && throttleMs <= 1000, 'THROTTLE', 'throttleMs must be 0–1000');
  requireContract(signal === undefined || signal && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function', 'SIGNAL', 'Expected an AbortSignal');
  requireContract(onUpdate === undefined || typeof onUpdate === 'function', 'CALLBACK', 'onUpdate must be a function');
  requireContract(onError === undefined || typeof onError === 'function', 'CALLBACK', 'onError must be a function');
  // Reject host configuration before a stream owns input or schedules updates. Keep mutable
  // caller configuration out of later snapshots; the preference store remains live by design.
  requireContract(options.mode === undefined || ['auto', 'text', 'rich'].includes(options.mode), 'MODE', 'mode must be auto, text or rich');
  requireContract(options.format === undefined || ['text', 'markdown'].includes(options.format), 'FORMAT', 'format must be text or markdown');
  if (options.title !== undefined) cleanText(options.title, 200);
  resolveContext(options.context);
  discoverFormats('', {inputFormat: options.inputFormat, columns: options.columns, final: false});
  options = {...options, policy: normalizePolicy(options.policy), context: {...options.context},
    capabilities: negotiateCapabilities(options.capabilities),
    ...(options.columns === undefined ? {} : {columns: structuredClone(options.columns)}),
    ...(Array.isArray(options.selectionKeys) ? {selectionKeys: [...options.selectionKeys]} : {})};
  const sources = normalizeSources(options.sources ?? []);
  const lifecycle = new AbortController();
  let compiledKey = '', compiled = null, compilations = 0;
  let text = '', status = 'streaming', timer = null, disposed = false, chunks = 0, renders = 0, reason = '', revision = 1;
  const snapshot = () => {
    const key=`${revision}:${status}`;
    if (key !== compiledKey) {
      // Every terminal state must expose an unfinished authored fence as readable text.
      // A cancelled/failed ordinary data stream is not a complete dataset: keep automatic
      // discovery off while retaining explicitly authored, already closed components.
      const interrupted = status === 'cancelled' || status === 'failed';
      compiled=compileMessage({id:messageId,content:text,revision},{...options,sources,
        ...(interrupted ? {policy:{...normalizePolicy(options.policy),mode:'off'}} : {}),final:status!=='streaming'});
      compiledKey=key;compilations++;
    }
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
    return snapshot();
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
