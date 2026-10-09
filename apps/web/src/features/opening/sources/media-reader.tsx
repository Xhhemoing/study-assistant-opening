"use client";

import type { MediaSegment, MediaSegmentsResponse, SourceRecord } from "@aistudy/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { LoadError, secondaryButtonClass } from "../design/ui";
import { sourceStatusLabel } from "../inbox/upload-state";

export type MediaReaderStateKind =
  | "loading"
  | "unavailable"
  | "parse_failed_original_saved"
  | "audio_only_transcript"
  | "insufficient_visual_coverage"
  | "ready"
  | "empty";

export function classifyMediaReaderState(input: {
  source: Pick<SourceRecord, "mime" | "parseState" | "uploadState"> | null;
  segments: readonly MediaSegment[] | null;
  unavailable?: boolean;
}): MediaReaderStateKind {
  if (input.unavailable) return "unavailable";
  if (!input.source) return "loading";
  if (input.source.parseState === "failed" || input.source.parseState === "unsupported") {
    return "parse_failed_original_saved";
  }
  if (input.segments == null) return "loading";
  if (input.segments.length === 0) return "empty";
  const mime = input.source.mime;
  if (mime.startsWith("audio/")) return "audio_only_transcript";
  if (mime.startsWith("video/")) {
    const frames = input.segments.reduce((n, s) => n + s.frameChunkIds.length, 0);
    if (frames === 0) return "insufficient_visual_coverage";
  }
  return "ready";
}

export function mediaReaderStateCopy(kind: MediaReaderStateKind): string {
  switch (kind) {
    case "parse_failed_original_saved":
      return "原件已保存，解析失败";
    case "audio_only_transcript":
      return "仅音频转写：未宣称理解板书或画面。";
    case "insufficient_visual_coverage":
      return "视觉覆盖不足：已有时间轴文本，关键帧不足以代表课件画面。";
    case "unavailable":
      return "媒体服务不可用，未展示示例内容。";
    case "empty":
      return "尚无可用片段。";
    case "loading":
      return "正在读取媒体片段…";
    default:
      return "可定位到时间轴片段；不宣称视觉理解。";
  }
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function MediaReader({
  sourceId,
  source,
  api: supplied,
  onSeek,
}: {
  sourceId: string;
  source?: Pick<SourceRecord, "mime" | "parseState" | "uploadState" | "name"> | null;
  api?: OpeningApi;
  onSeek?: (startMs: number) => void;
}) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const [payload, setPayload] = useState<MediaSegmentsResponse | null>(null);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(""); setUnavailable(false);
    try {
      setPayload(await api.getSourceSegments(sourceId));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "媒体片段暂时无法读取";
      if (/503|不可用|CONFIGURATION|not configured/i.test(message)) {
        setUnavailable(true);
        setPayload(null);
        setError(mediaReaderStateCopy("unavailable"));
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [api, sourceId]);

  useEffect(() => { void load(); }, [load]);

  const kind = classifyMediaReaderState({
    source: source ?? (payload ? { mime: "video/mp4", parseState: "ready", uploadState: "uploaded" } : null),
    segments: loading ? null : payload?.segments ?? [],
    unavailable,
  });

  if (loading && !payload) {
    return <p className="text-xs text-zinc-500" role="status">{mediaReaderStateCopy("loading")}</p>;
  }
  if (unavailable || error) {
    return <LoadError message={error || mediaReaderStateCopy("unavailable")} onRetry={() => void load()} />;
  }

  return (
    <section className="space-y-3" aria-labelledby={`media-reader-${sourceId}`}>
      <div>
        <h3 className="text-xs font-semibold text-zinc-800" id={`media-reader-${sourceId}`}>
          {source?.name ?? "媒体阅读"}
        </h3>
        <p className="mt-1 text-[11px] leading-5 text-zinc-500" role="status">
          {source ? sourceStatusLabel(source) : null}
          {source ? " · " : ""}
          {mediaReaderStateCopy(kind)}
          {payload && !payload.claimsVisualUnderstanding ? " · 不宣称视觉理解" : ""}
        </p>
      </div>
      {kind === "parse_failed_original_saved" || kind === "empty" ? null : (
        <ul className="max-h-64 space-y-2 overflow-y-auto text-xs leading-5 text-zinc-700" aria-label="媒体时间轴">
          {(payload?.segments ?? []).map((segment, index) => (
            <li key={`${segment.startMs}-${segment.endMs}-${index}`} className="rounded-md border border-zinc-200 bg-white px-3 py-2">
              <button
                type="button"
                className="font-medium text-emerald-800 underline-offset-2 hover:underline"
                onClick={() => onSeek?.(segment.startMs)}
              >
                {formatMs(segment.startMs)}–{formatMs(segment.endMs)}
              </button>
              <p className="mt-1 line-clamp-3 break-words text-zinc-700">{segment.text || "（无文本）"}</p>
              {segment.frameChunkIds.length === 0 && (source?.mime.startsWith("video/") ?? true) ? (
                <p className="mt-1 text-[11px] text-amber-800">本段无关键帧</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className={secondaryButtonClass} onClick={() => void load()}>重新读取</button>
    </section>
  );
}
