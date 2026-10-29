/**
 * Optional, host-injected AI assistance for presentation decisions.
 *
 * The host supplies `propose(request)` (any LLM) and optionally a cheap `gate(request)`. A model can
 * only (a) select keys of locally validated candidates, or (b) propose a component together with a
 * verbatim quote of the answer. Every proposal passes the same core checks as local extraction:
 * the quote must occur contiguously in the answer, the component must validate, and every number and
 * item must be grounded in the quote. Anything else is rejected and recorded. The local result is
 * always available first; a model result can only upgrade it (revision + 1) or leave it unchanged.
 * Nothing here performs network I/O by itself, and the user prompt is not shared unless allowPrompt.
 */
import {compileMessage, prepareMessage} from './index.mjs';
import {candidateKey, resolveContext} from '../policy/index.mjs';
import {MOTION_BY_TYPE} from '../policy/motion.mjs';
import {CATALOG, requireContract, cleanText} from '../core/document.mjs';
import {buildProposalBlock, groundingViolations, isVerbatimQuote} from '../core/grounding.mjs';
import {normalizeProviderUsage} from '../core/usage.mjs';

export const AI_TASKS = Object.freeze(['auto', 'lookup', 'compare', 'trend', 'relation', 'explain', 'review', 'inspect', 'plan']);
export const AI_PROPOSAL_TYPES = Object.freeze(['steps', 'checklist', 'chart', 'plot', 'timeline', 'compare', 'derivation']);
export const AI_ASSIST_INSTRUCTION = `你是 SenseWeave 的展示决策器。你不改写回答，只决定回答里哪些片段用结构化组件展示会明显更好读。
硬性规则：
1. 绝不编造、计算、汇总或补齐任何数据；组件中的每个数字、每个条目/标签都必须逐字出现在你给出的 quote 中。
2. quote 必须是回答原文中连续的一段，逐字复制。
3. 宁缺毋滥：叙事、故事、因果推理、零散且单位不同的数字、约数（大约/一半）、只有一两项的内容，保持文字。总数和部分不要画在同一张图里。
4. 用户要求只要文字/不要图/原样/翻译时，text_only=true 且不提议任何组件。
5. 组件总数不超过 constraints.maxSelections；只使用 allowedTypes 中的类型。
可用组件与 data 格式：
- steps: {"items":["逐字步骤",...]}  有先后顺序的操作或过程
- checklist: {"items":["逐字条目",...]}  需逐项准备/完成的事
- chart: {"unit":"单位","rows":[{"label":"逐字标签","value":数字}]}  同单位类别对比
- plot: {"unit":"单位","xLabel":"x名","yLabel":"y名","rows":[{"label":"逐字x","value":数字}]}  同一指标随时间/次序变化
- timeline: {"items":[{"when":"逐字时间","title":"逐字事件"}]}
- compare: {"columns":["维度","选项A","选项B"],"rows":[["维度名","A的内容","B的内容"]]}  定性对比
- derivation: {"lines":["逐字推导行",...]}  讲解时逐行板书的推导/公式（可能含答案）
local_candidates 是本地已校验的候选（带 key）；合适就把 key 放进 select。若本地候选的视图不对（例如年份表应画折线），可以不选它，改在 proposals 里给出新组件（quote 用整张表）。
还要给出：task（用户意图）、motion（可选，按组件类型给动画，只能用 motionPresets 中该类型允许的值）、style（"default" 或 "sketch"，讲解/批注/推导类上下文可用 sketch）、annotations（可选，最多 3 个需要圈画的关键短语，必须逐字出现在回答中）。
只输出 JSON：{"text_only":bool,"task":"compare|trend|explain|plan|lookup|inspect|review|relation|auto","select":["key"],"proposals":[{"type":"...","quote":"...","data":{...}}],"motion":{"steps":"step-through"},"style":"default","annotations":["短语"]}`;

const clip = (s, n) => String(s).slice(0, n);
function itemsOf(block) {
  const d = block.data;
  if (block.type === 'steps') return d.items;
  if (block.type === 'checklist') return d.items.map(x => x.text);
  if (block.type === 'derivation') return d.lines.map(x => x.text);
  if (block.type === 'timeline') return d.items.flatMap(x => [x.when, x.title]);
  return null;
}
/** Replace the quote only when the items cover it in order with punctuation-only gaps. */
function placementFor(block, quote) {
  const items = itemsOf(block);
  if (!items) return 'after';
  let at = 0;
  for (const item of items) {
    const i = quote.indexOf(item, at);
    if (i < 0 || !/^[\s，,。．；;、：:！!？?]*$/.test(quote.slice(at, i))) return 'after';
    at = i + item.length;
  }
  return /^[\s，,。．；;、：:！!？?]*$/.test(quote.slice(at)) ? 'replace' : 'after';
}

/**
 * Validate a raw model response against the prepared local snapshot.
 * Returns {textOnly, task, selectKeys, proposals (grounded candidates), suggestion, rejected}.
 */
export function validateAssistResponse(raw, {answer, candidates, allowedTypes, maxSelections}) {
  const rejected = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {invalid: true, rejected: [{type: 'response', reason: '模型输出不是 JSON 对象'}]};
  const task = AI_TASKS.includes(raw.task) ? raw.task : null;
  if (raw.task !== undefined && !task) rejected.push({type: 'task', reason: '意图不在白名单内'});
  const textOnly = raw.text_only === true;
  const keys = new Map(candidates.map(c => [candidateKey(c), c]));
  const selectKeys = [];
  for (const k of Array.isArray(raw.select) ? raw.select.slice(0, 8) : []) {
    if (typeof k === 'string' && keys.has(k) && !selectKeys.includes(k) && allowedTypes.includes(keys.get(k).block.type)) selectKeys.push(k);
    else rejected.push({type: 'select', key: clip(k, 160), reason: '未知、重复或宿主未启用的候选 key'});
  }
  const proposals = [];
  const taken = selectKeys.map(k => keys.get(k));
  (Array.isArray(raw.proposals) ? raw.proposals : []).slice(0, 6).forEach((p, i) => {
    const type = typeof p?.type === 'string' ? p.type : '';
    const reject = reason => rejected.push({type: Object.hasOwn(CATALOG, type) ? type : 'unknown', proposal: i, reason});
    if (selectKeys.length + proposals.length >= maxSelections) return reject('超出组件数量预算');
    if (!AI_PROPOSAL_TYPES.includes(type) || !allowedTypes.includes(type)) return reject('组件类型不在白名单或宿主未启用');
    if (!isVerbatimQuote(p.quote, answer)) return reject('quote 没有逐字连续出现在回答中');
    const quote = p.quote.trim(), start = answer.indexOf(quote), end = start + quote.length;
    let block;
    try {block = buildProposalBlock(type, p.data, `ai_${start}_${type}`);} catch (e) {return reject(`结构无效：${clip(e?.message ?? 'invalid', 80)}`);}
    const bad = groundingViolations(block, quote);
    if (bad.length) return reject(`未溯源的数据：${clip(JSON.stringify(bad), 80)}`);
    if ([...taken, ...proposals].some(c => c.start < end && start < c.end)) return reject('与已选内容重叠');
    proposals.push({id: block.id, block, start, end, placement: placementFor(block, quote)});
  });
  // Presentation-style suggestions: whitelisted here and filtered again by the motion planner.
  const motion = {};
  if (raw.motion && typeof raw.motion === 'object' && !Array.isArray(raw.motion))
    for (const [type, preset] of Object.entries(raw.motion).slice(0, 12)) {
      if ((MOTION_BY_TYPE[type] ?? []).includes(preset)) motion[type] = preset;
      else rejected.push({type: 'motion', reason: `动画 ${clip(preset, 30)} 不适用于 ${clip(type, 30)}`});
    }
  const style = raw.style === 'sketch' ? 'sketch' : raw.style === undefined || raw.style === 'default' ? 'default' : null;
  if (style === null) rejected.push({type: 'style', reason: '样式不在白名单内'});
  const annotations = (Array.isArray(raw.annotations) ? raw.annotations : []).slice(0, 3).filter(a => {
    const ok = typeof a === 'string' && a.trim().length >= 2 && a.length <= 40 && answer.includes(a.trim());
    if (!ok) rejected.push({type: 'annotation', reason: '批注短语没有逐字出现在回答中'});
    return ok;
  });
  return {textOnly, task, selectKeys, proposals, suggestion: {motion, style: style ?? 'default', annotations, tasks: task ? [task] : undefined}, rejected,
    proposedAny: (Array.isArray(raw.proposals) && raw.proposals.length > 0) || (Array.isArray(raw.select) && raw.select.length > 0)};
}

function withTimeout(fn, ms, outer) {
  const controller = new AbortController();
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => {controller.abort(); reject(Object.assign(new Error('timeout'), {status: 'timeout'}));}, ms);
    onAbort = () => {controller.abort(); reject(Object.assign(new Error('cancelled'), {status: 'cancelled'}));};
    if (outer?.aborted) onAbort(); else outer?.addEventListener('abort', onAbort, {once: true});
  });
  const work = Promise.resolve().then(() => fn(controller.signal));
  work.catch(() => {});
  return Promise.race([work, stopped]).finally(() => {clearTimeout(timer); outer?.removeEventListener('abort', onAbort);});
}

export function createAIAssist({propose, gate, gateThreshold = 0.6, timeoutMs = 5000, gateTimeoutMs = 2000, maxCalls = 64,
  cacheSize = 64, allowPrompt = false, maxInputChars = 12000, gateFailOpen = true, onUsage} = {}) {
  requireContract(typeof propose === 'function', 'ASSIST', 'A host-supplied propose function is required');
  requireContract(gate === undefined || typeof gate === 'function', 'ASSIST', 'gate must be a function');
  requireContract(Number.isFinite(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000 && Number.isFinite(gateTimeoutMs) && gateTimeoutMs >= 20 && gateTimeoutMs <= 30000, 'ASSIST', 'Invalid timeout');
  requireContract(Number.isInteger(maxCalls) && maxCalls >= 0 && maxCalls <= 10000 && Number.isInteger(cacheSize) && cacheSize >= 0 && cacheSize <= 1024, 'ASSIST', 'Invalid budget');
  requireContract(typeof allowPrompt === 'boolean' && Number.isFinite(gateThreshold) && gateThreshold >= 0 && gateThreshold <= 1 && Number.isInteger(maxInputChars) && maxInputChars >= 400 && maxInputChars <= 60000, 'ASSIST', 'Invalid assist configuration');
  requireContract(onUsage === undefined || typeof onUsage === 'function', 'ASSIST', 'onUsage must be a function');
  let calls = 0, gateCalls = 0, hits = 0;
  const cache = new Map();
  const observe = record => {try {Promise.resolve(onUsage?.(structuredClone(record))).catch(() => {});} catch {}};

  function annotate(envelope, ai, rejected = []) {
    const extra = rejected.filter(r => Object.hasOwn(CATALOG, r.type)).map(r => ({key: `ai:${r.proposal ?? 'x'}:${r.type}`, type: r.type, format: 'ai-proposal', score: 0, visualCost: 0, reasons: [`AI 提议被拒绝：${r.reason}`]}));
    return {...envelope, decision: {...envelope.decision, rejected: [...(envelope.decision.rejected ?? []), ...extra],
      extraModelCalls: ai.calls, ai: {...ai, rejected: rejected.map(r => ({...r, reason: clip(r.reason, 200)})).slice(0, 12)}}};
  }

  function progressive(message, options = {}) {
    const started = Date.now();
    const output = prepareMessage(message, options);
    const local = output.local, p = output.prepared;
    const base = {calls: 0, gateCalls: 0, status: 'pending', latencyMs: 0};
    const skip = status => ({local: annotate(local, {...base, status}), upgrade: Promise.resolve(null)});
    let intent = null;
    try {intent = resolveContext(options.context ?? {});} catch {}
    if (options.mode === 'text' || intent?.noUI || intent?.exact) return skip('text-requested');
    if (!p || options.final === false) return skip('skipped');
    if (p.context.noUI || p.context.exact) return skip('text-requested');
    if (p.context.sensitive) return skip('skipped-sensitive');
    if (p.policy.mode !== 'auto' || !p.cap.rich || !p.policy.maxEnhancements) return skip('disabled');
    if (local.decision.state === 'authored') return skip('authored');
    const answer = local.content;
    if (!answer || answer.length > maxInputChars) return skip('input-budget');
    const allowedTypes = p.context.allowedComponents.filter(t => p.cap.components.includes(t));
    const maxSelections = Math.min(p.policy.maxEnhancements, p.cap.maxInteractiveBlocks);
    const request = {instruction: AI_ASSIST_INSTRUCTION, answer, ...(allowPrompt ? {user_question: options.context?.prompt ?? ''} : {}),
      task: p.context.task, allowedTypes: AI_PROPOSAL_TYPES.filter(t => allowedTypes.includes(t)),
      constraints: {maxSelections, maxVisualCost: p.policy.maxVisualCost},
      local_candidates: p.candidates.filter(c => allowedTypes.includes(c.block.type)).map(c => ({key: candidateKey(c), type: c.block.type, localScore: c.score, source: clip(c.source ?? '', 300)})),
      local_selected: local.decision.selected.map(c => c.key),
      motionPresets: MOTION_BY_TYPE, styles: ['default', 'sketch']};
    const key = JSON.stringify([answer, allowPrompt ? options.context?.prompt ?? '' : '', options.context ?? {}, p.policy, allowedTypes]);
    const pendingLocal = annotate(local, {...base, status: 'pending'});
    const finishWith = (envelope, ai, rejected) => annotate(envelope, {...ai, latencyMs: Date.now() - started}, rejected);
    const apply = (v, ai) => {
      if (v.textOnly) {
        const text = compileMessage({...message, revision: (local.document.revision ?? 1) + 1}, {...options, mode: 'text'});
        return finishWith(text, {...ai, status: 'text-only', task: v.task}, v.rejected);
      }
      if (!v.selectKeys.length && !v.proposals.length && v.proposedAny) return finishWith(local, {...ai, status: 'rejected', task: v.task}, v.rejected);
      const selection = [...v.selectKeys, ...v.proposals.map(x => candidateKey({id: x.id, block: x.block}))];
      const next = compileMessage({...message, revision: (local.document.revision ?? 1) + 1}, {...options, groundedProposals: v.proposals, selectionKeys: selection,
        presentationSuggestion: v.suggestion});
      const accepted = next.decision.selected.map(c => ({key: c.key, type: c.type, source: c.format === 'ai-proposal' ? 'model-proposal' : 'local-candidate'}));
      return finishWith(next, {...ai, status: ai.status ?? 'accepted', task: v.task, accepted, style: v.suggestion.style, motion: v.suggestion.motion}, v.rejected);
    };
    if (cache.has(key)) {
      hits++;
      const v = cache.get(key);cache.delete(key);cache.set(key, v);
      return {local: pendingLocal, upgrade: Promise.resolve(apply(v, {calls: 0, gateCalls: 0, status: 'cache-hit'}))};
    }
    const upgrade = (async () => {
      let gateResult = null, gateCount = 0;
      if (gate) {
        gateCount = 1; gateCalls++;
        try {
          gateResult = await withTimeout(signal => gate({answer, ...(allowPrompt ? {user_question: options.context?.prompt ?? ''} : {}), task: p.context.task,
            local_selected: request.local_selected, local_candidates: request.local_candidates.map(c => ({key: c.key, type: c.type}))}, {signal}), gateTimeoutMs, options.signal);
        } catch (e) {
          if (e?.status === 'cancelled') return finishWith(local, {calls: 0, gateCalls: gateCount, status: 'cancelled'});
          if (!gateFailOpen) return finishWith(local, {calls: 0, gateCalls: gateCount, status: 'gate-failed'});
        }
        const textOnly = Number(gateResult?.textOnly), needs = Number(gateResult?.needsVisual);
        if (Number.isFinite(textOnly) && textOnly >= 0.5) {
          const text = compileMessage({...message, revision: (local.document.revision ?? 1) + 1}, {...options, mode: 'text'});
          return finishWith(text, {calls: 0, gateCalls: gateCount, status: 'gated-text-only', gate: {textOnly, needsVisual: Number.isFinite(needs) ? needs : null}});
        }
        if (Number.isFinite(needs) && needs < gateThreshold) return finishWith(local, {calls: 0, gateCalls: gateCount, status: 'gated', gate: {textOnly: Number.isFinite(textOnly) ? textOnly : null, needsVisual: needs}});
      }
      if (calls >= maxCalls) return finishWith(local, {calls: 0, gateCalls: gateCount, status: 'call-budget'});
      calls++;
      let usage = null;
      try {
        const raw = await withTimeout(signal => propose(structuredClone(request), {signal, onUsage: value => {usage = normalizeProviderUsage(value);}}), timeoutMs, options.signal);
        const v = validateAssistResponse(raw, {answer, candidates: p.candidates, allowedTypes, maxSelections});
        if (v.invalid) return finishWith(local, {calls: 1, gateCalls: gateCount, status: 'invalid', usage}, v.rejected);
        if (cacheSize) {if (cache.size >= cacheSize) cache.delete(cache.keys().next().value); cache.set(key, v);}
        observe({status: 'settled', latencyMs: Date.now() - started, usage});
        return apply(v, {calls: 1, gateCalls: gateCount, usage, ...(gateResult ? {gate: {textOnly: gateResult.textOnly ?? null, needsVisual: gateResult.needsVisual ?? null}} : {})});
      } catch (e) {
        const status = ['timeout', 'cancelled'].includes(e?.status) ? e.status : 'error';
        observe({status, latencyMs: Date.now() - started, usage});
        return finishWith(local, {calls: 1, gateCalls: gateCount, status, usage, ...(status === 'error' ? {error: clip(cleanText(String(e?.message ?? 'error'), 6000), 120)} : {})});
      }
    })();
    return {local: pendingLocal, upgrade};
  }
  return Object.freeze({
    /** Local result immediately; `upgrade` resolves to the final envelope (revision + 1 when it changed). */
    progressive,
    async render(message, options = {}) {const {local, upgrade} = progressive(message, options); return (await upgrade) ?? local;},
    stats: () => ({calls, gateCalls, cacheHits: hits, cacheEntries: cache.size, remaining: Math.max(0, maxCalls - calls)}),
    clearCache: () => cache.clear()
  });
}
