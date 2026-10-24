import {compileMessage, createOutputSession} from '../runtime/index.mjs';
import {extractText} from '../core/adapters.mjs';
import {requireContract, validId} from '../core/document.mjs';
/** A persistent custom data part; write inside an existing AI SDK UIMessage stream. */
export function toAISDKDataPart(envelope) {
  return {type: 'data-senseweave', id: envelope.messageId, data: envelope};
}
/** Text parts remain primary. Ignore reasoning/tool parts and revalidate all presentation input. */
export function fromAISDKMessage(message, options = {}) {
  const part = message.parts?.filter(p => p?.type === 'data-senseweave').at(-1);
  const text = extractText(message);
  return compileMessage({id: message.id, content: text || part?.data?.content || '', presentation: part?.data?.document}, options);
}
/** Remove only display parts before the HOST converts UI history into model input.
 * Does not remove text, tools, reasoning or consent records. Leaves the original UI history intact.
 */
export function stripSenseWeaveParts(message) {
  requireContract(message && typeof message === 'object' && !Array.isArray(message), 'MESSAGE', 'Expected message');
  requireContract(message.parts === undefined || Array.isArray(message.parts), 'MESSAGE', 'Expected parts array');
  return {...message, ...(message.parts ? {parts: message.parts.filter(p => p?.type !== 'data-senseweave')} : {})};
}
/** Opt in to uiMeta only after confirming the host forwards _meta to its iframe and
 * excludes it from the model context. This is NOT a guarantee for arbitrary MCP clients.
 */
export function toMCPResult(envelope, {uiMeta = false} = {}) {
  const content = [{type: 'text', text: envelope.text || envelope.content || '（空回答）'}];
  if (!uiMeta) return {content, structuredContent: {senseweave: envelope}, isError: false};
  return {content, structuredContent: {senseweaveSummary: {version: envelope.version, messageId: envelope.messageId,
    mode: envelope.mode, components: [...new Set(envelope.document.blocks.map(b => b.type))],
    state: envelope.decision?.state ?? envelope.mode}}, _meta: {senseweave: envelope}, isError: false};
}
/** Per-message AG-UI bridge. This deliberately ignores tools, reasoning and authorization events. */
export function createAGUIBridge({runId, sources = [], capabilities, onUpdate, maxMessages = 64, throttleMs = 32, policy, context, inputFormat, columns} = {}) {
  requireContract(typeof runId === 'string' && runId.length > 0, 'RUN', 'runId is required');
  requireContract(Number.isInteger(maxMessages) && maxMessages > 0 && maxMessages <= 1000, 'BUDGET', 'Invalid message limit');
  let status = 'idle';
  const sessions = new Map(), ended = new Set(), ignored = new Set();
  const rejectTerminal = () => requireContract(['idle', 'streaming'].includes(status), 'TERMINAL', 'AG-UI run is terminal');
  return Object.freeze({
    accept(event) {
      requireContract(event && typeof event.type === 'string', 'EVENT', 'Expected AG-UI event');
      if (event.runId !== undefined) requireContract(event.runId === runId, 'RUN', 'Mismatched runId');
      rejectTerminal();
      if (event.type === 'RUN_STARTED') {requireContract(status === 'idle', 'STATE', 'Duplicate run start'); status = 'streaming'; return true;}
      if (event.type === 'TEXT_MESSAGE_START') {
        requireContract(status === 'streaming', 'STATE', 'Message before run start');
        validId(event.messageId);
        requireContract(!sessions.has(event.messageId) && !ignored.has(event.messageId), 'DUPLICATE', 'Duplicate message start');
        if (event.role && event.role !== 'assistant') {
          requireContract(ignored.size < 1000, 'BUDGET', 'Ignored message limit reached');
          ignored.add(event.messageId);return false;
        }
        requireContract(sessions.size < maxMessages, 'BUDGET', 'Message limit reached');
        sessions.set(event.messageId, createOutputSession({messageId: event.messageId, sources, capabilities, throttleMs, onUpdate, policy, context, inputFormat, columns})); return true;
      }
      if (event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_END') {
        validId(event.messageId);
        if (ignored.has(event.messageId)) {
          requireContract(!ended.has(event.messageId), 'MESSAGE', 'Message already ended');
          if (event.type === 'TEXT_MESSAGE_END') ended.add(event.messageId);
          return false;
        }
        const session = sessions.get(event.messageId);
        requireContract(session && !ended.has(event.messageId), 'MESSAGE', 'Unknown or ended message');
        if (event.type === 'TEXT_MESSAGE_CONTENT') session.push(event.delta);
        else {session.finish(); ended.add(event.messageId);}
        return true;
      }
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
        requireContract(status === 'streaming', 'STATE', 'Terminal before run start');
        for (const [id, session] of sessions) if (!ended.has(id)) {
          session.fail(event.type === 'RUN_ERROR' ? String(event.message ?? '运行失败').slice(0, 1000) : '运行结束但缺少消息结束事件；不猜测回答完整性。');
          ended.add(id);
        }
        status = event.type === 'RUN_ERROR' ? 'failed' : 'completed'; return true;
      }
      return false;
    },
    getState: () => ({runId, status, messages: [...sessions.values()].map(s => s.getState())}),
    dispose() {for (const session of sessions.values()) session.dispose(); sessions.clear(); ended.clear(); ignored.clear(); status = 'disposed';}
  });
}

export * from './providers.mjs';
