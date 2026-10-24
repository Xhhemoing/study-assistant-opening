import {CATALOG, SCHEMA_VERSION, normalizeSources, validateDocument, projectText, plainDocument, bindText, documentScope, BINDING, resolveBinding, requireContract} from '../core/document.mjs';
import {compileExpr} from '../core/expr.mjs';
export const RUNTIME_VERSION = '0.5.0-rc.1';
export const DEFAULT_CAPABILITIES = Object.freeze({schemaVersions: Object.freeze([SCHEMA_VERSION]), components: Object.freeze(Object.keys(CATALOG)), rich: true, maxInteractiveBlocks: 6});
/** Host-owned settings only. These are never taken from model text. */
export function negotiateCapabilities(input = {}) {
  requireContract(input && typeof input === 'object' && !Array.isArray(input), 'CAPABILITIES', 'Invalid host capabilities');
  const versions = input.schemaVersions ?? [SCHEMA_VERSION];
  const types = input.components ?? Object.keys(CATALOG);
  requireContract(Array.isArray(versions) && Array.isArray(types) && types.length <= 100, 'CAPABILITIES', 'Expected capability lists');
  const max = input.maxInteractiveBlocks ?? 6;
  requireContract(Number.isInteger(max) && max >= 0 && max <= 40, 'CAPABILITIES', 'maxInteractiveBlocks must be 0–40');
  return {schemaVersions: versions.filter(v => v === SCHEMA_VERSION), rich: input.rich !== false && versions.includes(SCHEMA_VERSION), components: [...new Set(['prose', ...types.filter(t => typeof t === 'string' && Object.hasOwn(CATALOG, t))])], maxInteractiveBlocks: max};
}
/** Unsupported components become readable text, never disappear. The source envelope remains intact. */
export function applyCapabilities(input, capabilities, sources = [], {partial = false} = {}) {
  const registry = normalizeSources(sources);
  const doc = validateDocument(input, {sources: registry, partial});
  const cap = negotiateCapabilities(capabilities);
  const wholeText = () => projectText(doc, {includeOriginal: false});
  if (!cap.rich) return {document: validateDocument({...plainDocument(wholeText(), doc.id, doc.title, {format: 'text'}), originalText:doc.originalText}, {sources: registry}), downgraded: doc.blocks.filter(b => b.type !== 'prose').length};
  let count = 0;
  const disabled = new Set(doc.blocks.filter(b => b.type !== 'prose' && (!cap.components.includes(b.type) || ++count > cap.maxInteractiveBlocks)).map(b => b.id));
  if (!disabled.size) return {document: doc, downgraded: 0};
  const scope = documentScope(doc);
  // Freeze only bindings that depend on downgraded blocks; remaining calculators stay interactive.
  const freeze = text => text.replace(BINDING, (raw, expr, digits) => {
    try {
      if (![...compileExpr(expr).names].some(n => disabled.has(n.split('.')[0]))) return raw;
      const result = resolveBinding(expr, digits, scope);
      return result.ok ? result.text : raw;
    } catch {return raw;}
  });
  const blocks = doc.blocks.map(b => {
    if (!disabled.has(b.id)) return {...b, body: freeze(b.body)};
    const fragment = {...doc, title: '', summary: '', warnings: [], checks: [], originalText: '', sources: [], blocks: [{...b, body: bindText(b.body, scope)}]};
    return {id: b.id, type: 'prose', title: '', body: projectText(fragment, {includeOriginal: false}).trim(), format: 'text', data: {}};
  });
  return {document: validateDocument({...doc, summary: freeze(doc.summary), blocks, warnings: [...doc.warnings, '部分组件按宿主能力或展示预算降级为文字。'].slice(-16)}, {sources: registry, partial}), downgraded: disabled.size};
}
