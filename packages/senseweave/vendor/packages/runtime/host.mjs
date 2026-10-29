import {
  validateDocument,
  normalizeSources,
  requireContract,
  SCHEMA_VERSION,
  CATALOG
} from '../core/document.mjs';
import {compileMessage} from './index.mjs';
import {createInstructions} from './instructions.mjs';
import {createPreferenceStore, normalizePlacement} from '../policy/index.mjs';
/**
 * Host kit: lets a chat host keep its own Markdown renderer (math, citations, selection
 * mapping) for ordinary text and hand only the fragments SenseWeave selected to its
 * components. Segments always cover the whole original content in order, so joining
 * every segment's `source` returns `envelope.content` exactly.
 */
export function segmentOutput(envelope, {sources, placement} = {}) {
  requireContract(
    placement === undefined || placement === 'replace' || placement === 'append',
    'PLACEMENT',
    "placement must be 'replace' or 'append'"
  );
  requireContract(
    envelope && typeof envelope === 'object' && typeof envelope.content === 'string',
    'ENVELOPE',
    'Expected an OutputEnvelope'
  );
  const content = envelope.content,
    doc = envelope.document,
    decision = envelope.decision ?? {};
  const whole = [{kind: 'text', start: 0, end: content.length, source: content}];
  // Authored documents (sw: fences / explicit presentation) have no per-fragment ranges; text mode has nothing to split.
  if (
    envelope.mode !== 'rich' ||
    decision.state !== 'enhance' ||
    !doc ||
    !Array.isArray(decision.selected) ||
    !decision.selected.length
  )
    return whole;
  const registry = normalizeSources(sources ?? doc.sources ?? []);
  const byId = new Map(doc.blocks.map(b => [b.id, b]));
  const picks = [...decision.selected].sort((a, b) => a.start - b.start);
  const segments = [];
  let at = 0;
  for (const pick of picks) {
    const block = byId.get(pick.id);
    // A selected candidate later downgraded by capabilities is no longer a component: keep it as text.
    if (
      !block ||
      block.type === 'prose' ||
      !Number.isInteger(pick.start) ||
      !Number.isInteger(pick.end) ||
      pick.start < at ||
      pick.end > content.length ||
      pick.end <= pick.start
    )
      continue;
    // A supplementary view (candidate placement "after") is shown either in place of its verbatim
    // source span ('replace': the segment's source is that span, offered again behind "查看原文")
    // or after it ('append': the span stays host text and the block segment is zero-length).
    // Either way joining every segment's source returns the content exactly.
    const supplementary = pick.placement === 'after';
    const display = supplementary ? (placement ?? pick.display ?? 'append') : 'inline';
    const after = display === 'append';
    const cut = after ? pick.end : pick.start;
    if (cut > at)
      segments.push({
        kind: 'text',
        start: at,
        end: cut,
        source: content.slice(at, cut)
      });
    const source = after ? '' : content.slice(pick.start, pick.end);
    // The original travels with the block only when the block stands in for it.
    const {original: _, ...bare} = block;
    const shown = display === 'replace' ? {...bare, original: source} : supplementary ? bare : block;
    const document = validateDocument(
      {
        schemaVersion: SCHEMA_VERSION,
        id: `${doc.id}__${block.id}`.slice(0, 120),
        revision: doc.revision ?? 1,
        title: '',
        blocks: [shown],
        sources: registry,
        originalText: after ? content.slice(pick.start, pick.end) : source
      },
      {sources: registry}
    );
    segments.push({
      kind: 'block',
      start: after ? pick.end : pick.start,
      end: pick.end,
      source,
      type: block.type,
      blockId: block.id,
      reasons: [...(pick.reasons ?? [])],
      ...(supplementary ? {placement: display} : {}),
      ...(display === 'replace' ? {original: source} : {}),
      document,
      // Decoration hints for this block only (motion preset, sketch); annotations target host prose.
      ...(envelope.hints ? {hints: {documentId: document.id,
        motion: {enabled: !!envelope.hints.motion?.enabled, reason: envelope.hints.motion?.reason ?? '', blocks: envelope.hints.motion?.blocks?.[block.id] ? {[block.id]: envelope.hints.motion.blocks[block.id]} : {}},
        sketch: {enabled: !!envelope.hints.sketch?.enabled && (envelope.hints.sketch.blocks ?? []).includes(block.id), reason: envelope.hints.sketch?.reason ?? '', blocks: (envelope.hints.sketch?.blocks ?? []).filter(id => id === block.id)},
        annotations: [], rejected: []}} : {})
    });
    at = pick.end;
  }
  if (!segments.length) return whole;
  if (at < content.length)
    segments.push({kind: 'text', start: at, end: content.length, source: content.slice(at)});
  return segments;
}

const ALL = Object.keys(CATALOG);
const preset = (task, components, extra = {}) =>
  Object.freeze({
    context: Object.freeze({task}),
    capabilities: Object.freeze({
      components: Object.freeze(components.filter(c => ALL.includes(c))),
      maxInteractiveBlocks: extra.maxInteractiveBlocks ?? 2
    }),
    policy: Object.freeze({
      mode: 'auto',
      maxEnhancements: extra.maxEnhancements ?? 2,
      maxVisualCost: extra.maxVisualCost ?? 4
    }),
    intent: extra.intent ?? task,
    note: extra.note
  });
/**
 * Teaching presets from a real study-assistant host. They only narrow what the host allows;
 * they never claim the learner understood anything. `exercise` and `math` are left to hosts
 * that already have graded practice and a full TeX renderer.
 */
export const TEACHING_PRESETS = Object.freeze({
  hint: preset('explain', ['prose', 'callout', 'details'], {
    maxEnhancements: 1,
    maxVisualCost: 2,
    maxInteractiveBlocks: 1,
    intent: 'hint',
    note: '渐进提示：不展示完整解，下一步折叠'
  }),
  explain: preset('explain', ['prose', 'callout', 'steps', 'diagram', 'table', 'details'], {
    note: '讲解：分步与关系图，表格只读'
  }),
  derive: preset('explain', ['prose', 'callout', 'steps', 'diagram', 'calc', 'details'], {
    intent: 'calculate',
    note: '推导：公式明确时允许改参数看结果'
  }),
  review: preset('review', ['prose', 'callout', 'compare', 'table', 'checklist', 'details'], {
    note: '错题复盘：做法对照与错因清单'
  }),
  compare: preset('compare', ['prose', 'compare', 'table', 'chart'], {note: '概念对比：并列呈现'}),
  plan: preset('plan', ['prose', 'checklist', 'timeline', 'steps'], {
    note: '计划：只展示，勾选不等于已创建任务'
  }),
  data: preset('inspect', ['prose', 'table', 'chart', 'plot'], {
    maxVisualCost: 5,
    note: '成绩/练习数据：单位与轴明确才绘图'
  })
});
/** Merge a preset into host options; host-supplied values win where both are set. */
export function teachingOptions(name, options = {}) {
  requireContract(
    Object.hasOwn(TEACHING_PRESETS, name),
    'PRESET',
    `Unknown teaching preset: ${name}`
  );
  const p = TEACHING_PRESETS[name];
  return {
    ...options,
    mode: options.mode ?? 'auto',
    capabilities: {
      ...p.capabilities,
      components: [...p.capabilities.components],
      ...options.capabilities
    },
    policy: {...p.policy, ...options.policy},
    context: {...p.context, ...options.context}
  };
}

/**
 * One object for a chat host or agent: writing guidance for the model, a lossless split of each
 * finished answer, explicit feedback with host-owned persistence, and shadow-mode metrics.
 * Pure and SSR-safe (no DOM). Presentation failures always return the whole answer as text.
 */
export function createHostAdapter({
  preset: defaultPreset = 'explain',
  minChars = 0,
  sources,
  preferences: preferenceOptions,
  placement: defaultPlacement,
  options: baseOptions = {}
} = {}) {
  normalizePlacement(defaultPlacement);
  requireContract(
    Object.hasOwn(TEACHING_PRESETS, defaultPreset),
    'PRESET',
    `Unknown teaching preset: ${defaultPreset}`
  );
  requireContract(
    Number.isInteger(minChars) && minChars >= 0 && minChars <= 60000,
    'HOST',
    'minChars must be 0–60000'
  );
  const preferences = createPreferenceStore(preferenceOptions ?? {});
  const timings = [];
  const recent = new Map();
  const counts = {answers: 0, enhanced: 0, skippedShort: 0, fallbacks: 0, byType: {}, byPreset: {}};
  const pickPreset = name => {
    const p = name ?? defaultPreset;
    requireContract(Object.hasOwn(TEACHING_PRESETS, p), 'PRESET', `Unknown teaching preset: ${p}`);
    return p;
  };
  return Object.freeze({
    presets: Object.keys(TEACHING_PRESETS),
    /** Writing guidance to append to the system prompt. Never asks for sw: fences. */
    instructions(name) {
      const p = pickPreset(name);
      const intent = TEACHING_PRESETS[p].intent;
      return createInstructions({
        intent: ['hint', 'review'].includes(intent)
          ? intent
          : ['explain', 'compare', 'plan', 'calculate'].includes(intent)
            ? intent
            : undefined,
        maxChars: 1600
      });
    },
    /** Decide and split a finished answer. Streaming hosts call this once, after the last chunk. */
    prepare(text, {id = 'message', preset, prompt, final = true, options = {}} = {}) {
      const p = pickPreset(preset);
      // Re-renders (React StrictMode, list virtualisation) return the same object and are not recounted.
      const key =
        final && typeof text === 'string' && !Object.keys(options).length
          ? `${id}\u0000${p}\u0000${prompt ?? ''}\u0000${text}`
          : null;
      if (key && recent.has(key)) {
        const hit = recent.get(key);
        recent.delete(key);
        recent.set(key, hit);
        return hit;
      }
      const started = typeof performance === 'object' ? performance.now() : Date.now();
      const whole = [
        {
          kind: 'text',
          start: 0,
          end: typeof text === 'string' ? text.length : 0,
          source: typeof text === 'string' ? text : ''
        }
      ];
      let envelope = null,
        segments = whole,
        error = null;
      if (typeof text !== 'string') error = 'TEXT';
      else if (!final) segments = whole;
      else if (text.length < minChars) counts.skippedShort++;
      else {
        try {
          const merged = teachingOptions(p, {
            ...(defaultPlacement ? {placement: defaultPlacement} : {}),
            ...baseOptions,
            ...options,
            preferences,
            sources: sources ?? baseOptions.sources,
            context: {...baseOptions.context, ...options.context, ...(prompt ? {prompt} : {})}
          });
          envelope = compileMessage({id, content: text}, merged);
          segments = segmentOutput(envelope, {placement: merged.placement});
          if (envelope.diagnostics.some(d => d.code === 'PRESENTATION_FALLBACK'))
            counts.fallbacks++;
        } catch (e) {
          error = typeof e?.code === 'string' ? e.code : 'INVALID';
          counts.fallbacks++;
          segments = whole;
        }
      }
      const ms = (typeof performance === 'object' ? performance.now() : Date.now()) - started;
      if (final) {
        counts.answers++;
        counts.byPreset[p] = (counts.byPreset[p] ?? 0) + 1;
        const blocks = segments.filter(s => s.kind === 'block');
        if (blocks.length) counts.enhanced++;
        for (const b of blocks) counts.byType[b.type] = (counts.byType[b.type] ?? 0) + 1;
        timings.push(ms);
        if (timings.length > 500) timings.shift();
      }
      const result = Object.freeze({
        preset: p,
        segments,
        enhanced: segments.some(s => s.kind === 'block'),
        decision: envelope?.decision ?? null,
        diagnostics: envelope?.diagnostics ?? [],
        error,
        ms: +ms.toFixed(3),
        extraModelCalls: 0
      });
      if (key) {
        recent.set(key, result);
        if (recent.size > 64) recent.delete(recent.keys().next().value);
      }
      return result;
    },
    /** Explicit user feedback on one shown component ("改回文字" = helpful:false). */
    feedback({type, preset, helpful}) {
      const p = pickPreset(preset);
      preferences.record({component: type, task: TEACHING_PRESETS[p].context.task, helpful});
    },
    preferences,
    stats() {
      const sorted = [...timings].sort((a, b) => a - b);
      const at = q =>
        sorted.length
          ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(3)
          : 0;
      return {
        ...structuredClone(counts),
        enhancementRate: counts.answers ? +(counts.enhanced / counts.answers).toFixed(4) : 0,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        extraModelCalls: 0
      };
    }
  });
}

export {themeTokens} from './theme.mjs';
