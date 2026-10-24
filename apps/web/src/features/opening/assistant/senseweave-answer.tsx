"use client";

import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import type { BlockSegment, PreparedAnswer } from "@aistudy/senseweave/host";
import { LearningProse, type CitationLink } from "./learning-prose";
import type { QueryEvidenceLink } from "./query-evidence-links";
import { SENSEWEAVE_TOKENS, senseWeaveAdapter, type SenseWeaveMode } from "./senseweave-host";

type ProseProps = {
  citationLinks?: readonly CitationLink[];
  queryEvidenceLinks?: readonly QueryEvidenceLink[];
  objectHref?: (href: string) => string;
};

class BlockBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn("senseweave block failed; showing the original text", error); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** One bare SenseWeave component. The wrapper carries the fragment's source offsets for selection mapping. */
function SenseWeaveBlock({ segment, onFail }: { segment: BlockSegment; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const fail = useRef(onFail);
  fail.current = onFail;
  useEffect(() => {
    let alive = true;
    let mounted: { unmount(): void } | null = null;
    import("@aistudy/senseweave/block")
      .then(({ mountBlock }) => alive && host.current ? mountBlock(host.current, segment, { tokens: SENSEWEAVE_TOKENS, onError: () => fail.current() }) : null)
      .then(mount => {
        if (!mount) return;
        if (alive) mounted = mount;
        else mount.unmount();
      })
      .catch(() => { if (alive) fail.current(); });
    return () => {
      alive = false;
      mounted?.unmount();
    };
  }, [segment]);
  return <div ref={host} data-src-start={segment.start} data-src-end={segment.end} data-senseweave-block={segment.type} className="min-h-6" />;
}

type Props = ProseProps & { text: string; prepared: PreparedAnswer };

/** Diagnostics only: what SenseWeave chose for this answer (shadow mode shows it without changing the answer). */
export function SenseWeaveDiagnostics({ prepared, mode }: { prepared: PreparedAnswer; mode: Exclude<SenseWeaveMode, "off"> }) {
  const types = prepared.segments.flatMap(segment => segment.kind === "block" ? [segment.type] : []);
  return <p className="mt-2 text-xs text-text-3" data-senseweave-diagnostics={mode}>
    SenseWeave{mode === "shadow" ? "（影子）" : ""}：{types.length ? types.join("、") : "保持文字"} · {prepared.preset} · {prepared.ms.toFixed(1)} ms
  </p>;
}

/**
 * A finished answer SenseWeave enhanced: selected fragments become bare components, every other
 * fragment stays LearningProse with its original offsets. Any component failure shows its source text.
 */
export function SenseWeaveAnswer({ text, prepared, ...prose }: Props) {
  const [asText, setAsText] = useState<ReadonlySet<string>>(() => new Set());
  const keepText = (blockId: string) => setAsText(previous => new Set(previous).add(blockId));
  if (!prepared.enhanced) return <LearningProse text={text} {...prose} />;
  return <>
    {prepared.segments.map(segment => {
      const key = `${segment.start}:${segment.end}`;
      const original = <LearningProse text={segment.source} sourceOffset={segment.start} {...prose} />;
      if (segment.kind === "text" || asText.has(segment.blockId)) return <div key={key}>{original}</div>;
      return <figure key={key} className="my-4" aria-label="图示（由回答内容整理，原文为准）">
        <BlockBoundary fallback={original}><SenseWeaveBlock segment={segment} onFail={() => keepText(segment.blockId)} /></BlockBoundary>
        <figcaption className="mt-1 flex justify-end">
          <button
            type="button"
            className="min-h-7 rounded-pill px-2 text-xs text-text-3 transition-colors hover:bg-text/5 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            onClick={() => {
              keepText(segment.blockId);
              senseWeaveAdapter().feedback({ type: segment.type, preset: prepared.preset, helpful: false });
            }}
          >改回文字</button>
        </figcaption>
      </figure>;
    })}
  </>;
}
