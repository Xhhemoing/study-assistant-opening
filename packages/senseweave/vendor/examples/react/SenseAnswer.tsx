'use client';
/**
 * Drop-in React answer renderer for chat hosts that already render Markdown themselves
 * (AIstudy's LearningProse, a react-markdown pipeline, etc.). Copy this file into the host.
 *
 *  - While streaming: the whole text goes to the host renderer; nothing jumps.
 *  - When final: SenseWeave decides once; selected fragments mount as bare <sense-weave> blocks,
 *    everything else stays host text with its original offsets.
 *  - Any block failure falls back to the host renderer for that fragment only.
 *  - "改回文字" turns one block back into host text and records explicit feedback.
 *  - A supplementary view replaces its verbatim sentence by default; the sentence stays one
 *    click away under “查看原文”, and "改回文字"/failures render that sentence as host text.
 *
 * React is the host's dependency, not SenseWeave's.
 */
import {Component, createElement, Fragment, useEffect, useMemo, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {
  createHostAdapter,
  type HostAdapter,
  type BlockSegment,
  type OutputSegment,
  type TeachingPresetName,
  type HostThemeColors
} from '../../packages/runtime/host.mjs';
import type {InlineRenderer, Interaction} from '../../packages/element/sense-weave.mjs';

export type RenderText = (source: string, range: {start: number; end: number; /** Inline source uses the containing block range. */ inline?: boolean}) => ReactNode;
export interface SenseAnswerProps {
  /** The answer text exactly as the model produced it. */
  text: string;
  /** True until the last chunk has arrived. No decision is made while streaming. */
  streaming?: boolean;
  /** Stable message id (used for block ids and React keys). */
  id?: string;
  preset?: TeachingPresetName;
  /** The user's question; only used for no-UI requests and task cues. */
  prompt?: string;
  /** Host Markdown renderer for text and inline table source. Inline calls carry the containing block range. */
  renderText: RenderText;
  /** Shared adapter (keeps preferences and metrics across messages). One is created if omitted. */
  adapter?: HostAdapter;
  /** Global switch: false renders host text only (feature flag off / user chose plain text). */
  enabled?: boolean;
  tokens?: HostThemeColors;
  theme?: 'light' | 'dark' | 'auto';
  renderInline?: InlineRenderer;
  /**
   * Supplementary views (a chart/compare read verbatim from one sentence): 'replace' shows the
   * block in place of that sentence with a collapsed “查看原文”; 'append' keeps the sentence and
   * adds the view after it. Default: the adapter's setting ('replace' unless configured).
   */
  placement?: 'replace' | 'append';
  /** Show a small "改回文字" control under each block. Default true. */
  allowPlain?: boolean;
  onInteraction?: (event: Interaction) => void;
  /** Called once per final answer with what was shown (for shadow metrics / logging). */
  onPrepared?: (info: {enhanced: boolean; types: string[]; ms: number}) => void;
}

// Evaluated only when React actually renders a text path, including a boundary fallback.
// A host renderer failure must never remove the original answer.
function HostText({source, range, renderText}: {source: string; range: Parameters<RenderText>[1]; renderText: RenderText}) {
  const literal = createElement('span', {style: {whiteSpace: 'pre-wrap'}}, source);
  try {
    // The callback may return a component that throws later during reconciliation.
    // Never invoke host rendering again from this boundary's fallback.
    return createElement(BlockBoundary, {
      key: JSON.stringify([source, range.start, range.end, range.inline]),
      fallback: literal
    }, renderText(source, range));
  } catch { return literal; }
}

class BlockBoundary extends Component<
  {fallback: ReactNode; children?: ReactNode},
  {failed: boolean}
> {
  state = {failed: false};
  static getDerivedStateFromError() {
    return {failed: true};
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function SenseBlock(props: {
  segment: BlockSegment;
  tokens?: HostThemeColors;
  theme?: 'light' | 'dark' | 'auto';
  renderInline?: InlineRenderer;
  renderText: RenderText;
  onInteraction?: (e: Interaction) => void;
  onFail: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [portals, setPortals] = useState<{target: HTMLElement; source: string; key: number}[]>([]);
  const nextPortalKey = useRef(0);
  useEffect(() => {
    let alive = true;
    let queued = false;
    type Entry = {target: HTMLElement; source: string; key: number};
    const entries: Entry[] = [];
    let published: Entry[] = [];
    let roots = new Set<Node>();
    // StrictMode may replay setup after cleanup without discarding React state.
    setPortals([]);
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => schedule());
    const reconcile = () => {
      queued = false;
      if (!alive) return;
      const attached = entries.filter(entry => entry.target.isConnected);
      entries.splice(0, entries.length, ...attached);
      // A document observer cannot see into shadow DOM. Observe every root on
      // each target's ancestry, including outer roots if shadow hosts move.
      const nextRoots = new Set<Node>();
      for (const {target} of observer ? attached : []) {
        let node: Node = target;
        for (;;) {
          const root = node.getRootNode();
          nextRoots.add(root);
          if (!(root instanceof ShadowRoot)) break;
          node = root.host;
        }
      }
      if (roots.size !== nextRoots.size || [...roots].some(root => !nextRoots.has(root))) {
        observer?.disconnect();
        roots = nextRoots;
        for (const root of roots) observer?.observe(root, {childList: true, subtree: true});
      }
      // React's own portal mutations must not trigger another state update.
      if (attached.length !== published.length || attached.some((entry, i) => entry !== published[i])) {
        published = attached;
        setPortals(attached);
      }
    };
    function schedule() {
      if (!alive || queued) return;
      queued = true;
      // Coalesce synchronous detach/reinsert (e.g. sorting) before checking.
      queueMicrotask(reconcile);
    }
    // DOM hooks return DOM nodes only. React renders host content through portals.
    const inline: InlineRenderer = (source, info) => {
      if (!alive) return null;
      if (latest.current.renderInline) return latest.current.renderInline(source, info);
      if (info.type !== 'table') return null;
      const target = document.createElement('span');
      entries.push({target, source, key: nextPortalKey.current++});
      schedule();
      return target;
    };
    let mount: {unmount(): void} | null = null;
    import('../../packages/browser/block.mjs')
      .then(({mountBlock}) => {
        if (!alive || !host.current) return null;
        return mountBlock(host.current, props.segment, {
          tokens: props.tokens,
          theme: props.theme,
          renderInline: inline,
          onInteraction: e => latest.current.onInteraction?.(e),
          onError: () => latest.current.onFail()
        });
      })
      .then(m => {
        if (!m) return;
        if (alive) mount = m;
        else m.unmount();
      })
      .catch(() => alive && latest.current.onFail());
    return () => {
      alive = false;
      observer?.disconnect();
      roots.clear();
      entries.length = 0;
      published = [];
      mount?.unmount();
    };
  }, [props.segment]);
  return createElement(Fragment, null, createElement('div', {
    ref: host,
    className: 'sw-block',
    'data-src-start': props.segment.start,
    'data-src-end': props.segment.end
  }), ...portals.map(({target, source, key}) => createPortal(
    createElement(HostText, {source, range: {start: props.segment.start, end: props.segment.end, inline: true}, renderText: props.renderText}), target, String(key)
  )));
}

let shared: HostAdapter | null = null;
const defaultAdapter = () => (shared ??= createHostAdapter());

export function SenseAnswer(props: SenseAnswerProps) {
  const {text, streaming = false, enabled = true, allowPlain = true, renderText} = props;
  const adapter = props.adapter ?? defaultAdapter();
  const newOwner = () => ({id: props.id, text, token: {}, plain: new Set<string>(), failed: new Set<string>()});
  const [storedOwner, setOwner] = useState(newOwner);
  // Reset during render, not in an effect: a replacement answer must never paint
  // with the previous answer's withdrawals/failures, even when block ids repeat.
  let owner = storedOwner;
  if (owner.id !== props.id || owner.text !== text) {
    owner = newOwner();
    setOwner(owner);
  }
  const {plain, failed} = owner;
  const prepared = useMemo(() => {
    if (!enabled || streaming) return null;
    return adapter.prepare(text, {
      id: props.id ?? 'message',
      preset: props.preset,
      prompt: props.prompt,
      // Only passed when set, so the adapter's re-render cache still applies.
      ...(props.placement ? {options: {placement: props.placement}} : {})
    });
  }, [adapter, enabled, streaming, text, props.id, props.preset, props.prompt, props.placement]);
  const reported = useRef<unknown>(null);
  useEffect(() => {
    if (!prepared || reported.current === prepared) return;
    reported.current = prepared;
    try {
      Promise.resolve(props.onPrepared?.({
        enhanced: prepared.enhanced,
        types: prepared.segments.flatMap(s => (s.kind === 'block' ? [s.type] : [])),
        ms: prepared.ms
      })).catch(() => {});
    } catch { /* Host diagnostics do not own answer rendering. */ }
  }, [prepared]);
  const segments: OutputSegment[] = prepared?.segments ?? [
    {kind: 'text', start: 0, end: text.length, source: text}
  ];
  const children = segments.map((s): ReactNode => {
    const key = JSON.stringify([props.id, text, s.start, s.end]);
    const asText = createElement(HostText, {source: s.source, range: {start: s.start, end: s.end}, renderText});
    if (s.kind === 'text' || plain.has(s.blockId) || failed.has(s.blockId))
      return createElement(Fragment, {key}, asText);
    const fail = () => setOwner(prev => prev.token === owner.token
      ? {...prev, failed: new Set(prev.failed).add(s.blockId)} : prev);
    const toPlain = () => {
      setOwner(prev => prev.token === owner.token
        ? {...prev, plain: new Set(prev.plain).add(s.blockId)} : prev);
      try {
        adapter.feedback({type: s.type, preset: prepared?.preset, helpful: false});
      } catch {}
    };
    return createElement(
      'figure',
      {key, className: 'sw-figure', style: {margin: '12px 0'}},
      createElement(
        BlockBoundary,
        {fallback: asText},
        createElement(SenseBlock, {
          segment: s,
          tokens: props.tokens,
          theme: props.theme,
          renderInline: props.renderInline,
          renderText,
          onInteraction: props.onInteraction,
          onFail: fail
        })
      ),
      allowPlain
        ? createElement(
            'button',
            {
              type: 'button',
              className: 'sw-to-plain',
              onClick: toPlain,
              style: {
                font: 'inherit',
                fontSize: '12px',
                opacity: 0.7,
                background: 'none',
                border: 0,
                padding: '2px 0',
                cursor: 'pointer'
              }
            },
            '改回文字'
          )
        : null
    );
  });
  return createElement(Fragment, null, ...children);
}
