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
 *
 * React is the host's dependency, not SenseWeave's.
 */
import {Component, createElement, Fragment, useEffect, useMemo, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {
  createHostAdapter,
  type HostAdapter,
  type BlockSegment,
  type OutputSegment,
  type TeachingPresetName,
  type HostThemeColors
} from '../../packages/runtime/host.mjs';
import type {InlineRenderer, Interaction} from '../../packages/element/sense-weave.mjs';

export type RenderText = (source: string, range: {start: number; end: number}) => ReactNode;
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
  /** Host Markdown renderer for unselected text. Receives original UTF-16 offsets. */
  renderText: RenderText;
  /** Shared adapter (keeps preferences and metrics across messages). One is created if omitted. */
  adapter?: HostAdapter;
  /** Global switch: false renders host text only (feature flag off / user chose plain text). */
  enabled?: boolean;
  tokens?: HostThemeColors;
  theme?: 'light' | 'dark' | 'auto';
  renderInline?: InlineRenderer;
  /** Show a small "改回文字" control under each block. Default true. */
  allowPlain?: boolean;
  onInteraction?: (event: Interaction) => void;
  /** Called once per final answer with what was shown (for shadow metrics / logging). */
  onPrepared?: (info: {enhanced: boolean; types: string[]; ms: number}) => void;
}

class BlockBoundary extends Component<
  {fallback: ReactNode; children: ReactNode},
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
  onInteraction?: (e: Interaction) => void;
  onFail: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    let alive = true;
    let mount: {unmount(): void} | null = null;
    import('../../packages/browser/block.mjs')
      .then(({mountBlock}) => {
        if (!alive || !host.current) return null;
        return mountBlock(host.current, props.segment, {
          tokens: props.tokens,
          theme: props.theme,
          renderInline: props.renderInline,
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
      mount?.unmount();
    };
  }, [props.segment]);
  return createElement('div', {
    ref: host,
    className: 'sw-block',
    'data-src-start': props.segment.start,
    'data-src-end': props.segment.end
  });
}

let shared: HostAdapter | null = null;
const defaultAdapter = () => (shared ??= createHostAdapter());

export function SenseAnswer(props: SenseAnswerProps) {
  const {text, streaming = false, enabled = true, allowPlain = true, renderText} = props;
  const adapter = props.adapter ?? defaultAdapter();
  const [plain, setPlain] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const prepared = useMemo(() => {
    if (!enabled || streaming) return null;
    return adapter.prepare(text, {
      id: props.id ?? 'message',
      preset: props.preset,
      prompt: props.prompt
    });
  }, [adapter, enabled, streaming, text, props.id, props.preset, props.prompt]);
  const reported = useRef<unknown>(null);
  useEffect(() => {
    if (!prepared || reported.current === prepared) return;
    reported.current = prepared;
    props.onPrepared?.({
      enhanced: prepared.enhanced,
      types: prepared.segments.flatMap(s => (s.kind === 'block' ? [s.type] : [])),
      ms: prepared.ms
    });
  }, [prepared]);
  const segments: OutputSegment[] = prepared?.segments ?? [
    {kind: 'text', start: 0, end: text.length, source: text}
  ];
  const children = segments.map((s): ReactNode => {
    const key = `${s.start}:${s.end}`;
    const asText = renderText(s.source, {start: s.start, end: s.end});
    if (s.kind === 'text' || plain.has(s.blockId) || failed.has(s.blockId))
      return createElement(Fragment, {key}, asText);
    const fail = () => setFailed(prev => new Set(prev).add(s.blockId));
    const toPlain = () => {
      setPlain(prev => new Set(prev).add(s.blockId));
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
