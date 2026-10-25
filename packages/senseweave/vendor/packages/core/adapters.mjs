import {plainDocument, validateDocument, normalizeSources} from './document.mjs';
/**
 * Existing chat messages do not need a new agent framework. Pass `format: 'markdown'` to render
 * the content through the safe Markdown subset; the default keeps it as literal text.
 */
export function fromChatMessage(message, {sources = [], format = 'text', onDiagnostic} = {}) {
  if (!message || typeof message !== 'object') throw new TypeError('Expected a chat message');
  // Validate the registry outside the fallback boundary: malformed host authorization must fail closed.
  const registry = normalizeSources(sources);
  const content = extractText(message);
  const id = typeof message.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(message.id)
    ? message.id : 'message';
  if (message.presentation) {
    try {
      return validateDocument({...message.presentation, originalText: content || message.presentation.originalText || ''}, {sources: registry});
    } catch (error) {
      onDiagnostic?.({code: error.code ?? 'PRESENTATION', message: '增强数据无效；保留原始正文。'});
      const doc = validateDocument(plainDocument(content, id, '正文', {format}), {sources: registry});
      doc.warnings.push('增强数据无效；已回退到原始正文。');
      return doc;
    }
  }
  return validateDocument(plainDocument(content, id, '正文', {format}), {sources: registry});
}
/** Text parts only. Never display hidden reasoning, images or tool arguments as assistant prose. */
export function extractText(message) {
  if (typeof message?.content === 'string') return message.content;
  const parts = Array.isArray(message?.content) ? message.content : message?.parts;
  // Gemini parts carry no type ({text}); its thinking parts are marked thought:true and stay hidden.
  if (Array.isArray(parts)) return parts.filter(p => p && (['text', 'input_text', 'output_text'].includes(p.type) || p.type === undefined && typeof p.text === 'string' && p.thought !== true))
    .map(p => typeof p.text === 'string' ? p.text : typeof p.text?.value === 'string' ? p.text.value : '').join('');
  if (message?.content == null) return '';
  throw new TypeError('Message content must be a string or text parts');
}
/** Explicit subset only. Caller supplies trusted run/sequence; tool-end is NOT business-success. */
export function adaptAGUI(event, {runId, seq}) {
  const base = {runId, seq};
  if (event.type === 'TEXT_MESSAGE_CONTENT')
    return {...base, type: 'text.delta', delta: event.delta};
  if (event.type === 'RUN_STARTED') return {...base, type: 'run.started'};
  if (event.type === 'RUN_FINISHED') return {...base, type: 'run.completed'};
  if (event.type === 'RUN_ERROR')
    return {...base, type: 'run.failed', message: event.message ?? 'Agent 运行失败'};
  return null; // Tool calls, state and approvals require the host's own mapping.
}
