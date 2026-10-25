import {validateDecision} from './decision.mjs';
import {requireContract, validateDocument, cleanText, validId} from './document.mjs';
export function createRunState(runId) {
  validId(runId);
  return {
    runId,
    lastSeq: 0,
    status: 'idle',
    text: '',
    document: null,
    notice: '',
    route: null,
    metrics: null,
    decision: null,
    startedAt: null,
    firstTextAt: null,
    committedAt: null
  };
}
/** Sequenced at-least-once delivery. No arbitrary JSON Patch, no model-authored action receipts. */
export function reduceEvent(state, event, {sources = []} = {}) {
  requireContract(event && event.runId === state.runId, 'RUN', '事件所属 run 不匹配');
  requireContract(Number.isSafeInteger(event.seq) && event.seq > 0, 'SEQUENCE', '事件序号不合法');
  if (event.seq <= state.lastSeq) return state;
  requireContract(
    event.seq === state.lastSeq + 1,
    'GAP',
    '检测到事件缺口，需要续传，不能猜测完成状态'
  );
  requireContract(
    !['complete', 'cancelled', 'failed'].includes(state.status),
    'TERMINAL',
    '终态后不可再追加事件'
  );
  const s = {...state, lastSeq: event.seq};
  switch (event.type) {
    case 'run.started':
      requireContract(state.status === 'idle', 'STATE', '重复开始');
      s.status = 'streaming';
      s.startedAt = event.at ?? null;
      break;
    case 'text.delta':
      requireContract(state.status === 'streaming', 'STATE', '正文出现在开始之前');
      cleanText(event.delta, 20000);
      requireContract(s.text.length + event.delta.length <= 60000, 'BUDGET', '正文超出预算');
      s.text += event.delta;
      s.firstTextAt ??= event.at ?? null;
      break;
    case 'document.commit':
      requireContract(state.status === 'streaming', 'STATE', '提交状态不合法');
      s.document = validateDocument(event.document, {sources});
      s.committedAt = event.at ?? null;
      break;
    case 'run.decision':
      requireContract(state.status === 'streaming', 'STATE', '决策说明出现在开始之前');
      s.decision = validateDecision(event.decision);
      break;
    case 'run.metrics': {
      const m = event.metrics;
      requireContract(state.status === 'streaming' && m &&
        ['durationMs', 'componentCount', 'warningCount'].every(k => Number.isSafeInteger(m[k]) && m[k] >= 0) &&
        (m.firstTextMs === null || Number.isSafeInteger(m.firstTextMs) && m.firstTextMs >= 0),
        'METRICS', '运行指标不合法');
      const usage = m.usage;
      requireContract(usage === null || usage &&
        ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0), 'METRICS', '用量指标不合法');
      s.metrics = {durationMs: m.durationMs, firstTextMs: m.firstTextMs, componentCount: m.componentCount, warningCount: m.warningCount,
        usage: usage ? {prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens} : null};
      break;
    }
    case 'run.notice':
      s.notice = cleanText(event.message, 2000);
      break;
    case 'run.route':
      // Which answer template the pre-router chose, and why. Informational only.
      requireContract(state.status === 'streaming', 'STATE', '路由信息出现在开始之前');
      s.route = {template: cleanText(event.template, 40), reason: cleanText(event.reason, 200)};
      break;
    case 'run.completed':
      requireContract(state.status === 'streaming', 'STATE', '完成状态不合法');
      s.status = 'complete';
      break;
    case 'run.cancelled':
      s.status = 'cancelled';
      break;
    case 'run.failed':
      s.status = 'failed';
      s.notice = cleanText(event.message, 2000);
      break;
    default:
      throw Object.assign(new Error('未知事件；未改变原状态'), {code: 'EVENT'});
  }
  return s;
}
/** Small SSE decoder with UTF-8 support in consumeSSE; comments and CRLF supported. */
export function createSSEDecoder(onEvent, maxBuffer = 220000) {
  let pending = '',
    data = [],
    dataSize = 0,
    id = '',
    kind = 'message',
    skipLF = false;
  function line(s) {
    if (s === '') {
      if (data.length) onEvent({id, type: kind, data: data.join('\n')});
      data = [];
      dataSize = 0;
      kind = 'message';
      return;
    }
    if (s.startsWith(':')) return;
    const at = s.indexOf(':');
    const name = at < 0 ? s : s.slice(0, at);
    let value = at < 0 ? '' : s.slice(at + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'data') {
      dataSize += value.length + (data.length ? 1 : 0);
      requireContract(dataSize <= maxBuffer, 'BUDGET', 'SSE 事件超出预算');
      data.push(value);
    } else if (name === 'id' && !value.includes('\0')) id = value;
    else if (name === 'event') kind = value;
  }
  return {
    push(chunk) {
      // SSE permits CR, LF and CRLF, including a CRLF split between transport chunks.
      if (skipLF && chunk) {
        if (chunk[0] === '\n') chunk = chunk.slice(1);
        skipLF = false;
      }
      pending += chunk;
      let start = 0,
        i = 0;
      for (; i < pending.length; i++) {
        const char = pending[i];
        if (char !== '\n' && char !== '\r') continue;
        line(pending.slice(start, i));
        if (char === '\r') {
          if (pending[i + 1] === '\n') i++;
          else if (i === pending.length - 1) skipLF = true;
        }
        start = i + 1;
      }
      pending = pending.slice(start);
      // Only the unfinished line is bounded; a large chunk of many complete events is fine.
      requireContract(pending.length <= maxBuffer, 'BUDGET', 'SSE 缓冲超出预算');
    },
    end() {
      /* incomplete frame is deliberately not dispatched */
    },
    get pending() {
      return pending;
    }
  };
}
export async function consumeSSE(response, onEvent) {
  requireContract(response.ok && response.body, 'HTTP', `连接失败：${response.status}`);
  const parser = createSSEDecoder(onEvent);
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, {stream: true}));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
