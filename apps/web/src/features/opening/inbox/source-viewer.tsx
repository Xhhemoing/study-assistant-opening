import { validConversationId } from "../assistant/conversation-links";
import { NativePdfPreview } from "./native-pdf-preview";
import type { SourceRecord } from "@aistudy/contracts";
import { z } from "zod";
import { sourceStatusLabel } from "./upload-state";
import { ui } from "../design/ui";
import { sourcePreviewKind } from "../sources/preview-mime";
import { SourceTextPreview } from "./source-text-preview";
import { SourceVersionDetails } from "./source-version-details";

export type SourceDownloadView = {
  /** Same-origin download path preferred; MinIO hosts must never appear here for browser open. */
  url: string;
  expiresAt: string;
  version: number;
  currentVersion: number;
  versionMismatch: boolean;
};

export type SourceViewerLocators = {
  page?: number | null;
  startMs?: number | null;
  slideLabel?: string | null;
};

export type SourceViewerTarget = {
  conversationId?: string;
  sourceId: string;
  version: number;
  page?: number;
  startMs?: number;
  slideLabel?: string;
};

/** In-app materials viewer deep-link (cite Package D). Download stays secondary. */
export function sourceViewerHref(
  sourceId: string,
  version: number,
  locators: SourceViewerLocators = {},
): string {
  const params = new URLSearchParams({
    tab: "materials",
    source: sourceId,
    version: String(version),
  });
  if (locators.page != null && locators.page > 0) params.set("page", String(locators.page));
  if (locators.startMs != null && locators.startMs >= 0) params.set("startMs", String(locators.startMs));
  if (locators.slideLabel) params.set("slide", locators.slideLabel);
  return `/opening/library?${params.toString()}`;
}

/** Same-origin binary download (attachment); optional `#page=` for PDF viewers that honor it. */
export function sourceDownloadHref(sourceId: string, version: number, page?: number | null): string {
  const base = `/api/opening/sources/${sourceId}/download?version=${version}`;
  return page != null && page > 0 ? `${base}#page=${page}` : base;
}

/** Same-origin inline preview URL for PDF / image / plain / markdown. */
export function sourcePreviewHref(sourceId: string, version: number, page?: number | null): string {
  const base = `/api/opening/sources/${sourceId}/download?version=${version}&disposition=inline`;
  return page != null && page > 0 ? `${base}#page=${page}` : base;
}

export function parseSourceViewerSearchParams(input: {
  source?: string;
  version?: string;
  page?: string;
  startMs?: string;
  slide?: string;
  conversation?: string;
}): SourceViewerTarget | null {
  const parsed = z.object({
    source: z.string().uuid(),
    version: z.coerce.number().int().nonnegative(),
    page: z.coerce.number().int().positive().optional(),
    startMs: z.coerce.number().int().nonnegative().optional(),
    slide: z.string().min(1).max(120).optional(),
  }).safeParse({
    source: input.source,
    version: input.version ?? "0",
    ...(input.page != null && input.page !== "" ? { page: input.page } : {}),
    ...(input.startMs != null && input.startMs !== "" ? { startMs: input.startMs } : {}),
    ...(input.slide?.trim() ? { slide: input.slide.trim() } : {}),
  });
  if (!parsed.success) return null;
  const conversationId = input.conversation && validConversationId(input.conversation) ? input.conversation : undefined;
  return {
    ...(conversationId ? { conversationId } : {}),
    sourceId: parsed.data.source,
    version: parsed.data.version,
    ...(parsed.data.page != null ? { page: parsed.data.page } : {}),
    ...(parsed.data.startMs != null ? { startMs: parsed.data.startMs } : {}),
    ...(parsed.data.slide ? { slideLabel: parsed.data.slide } : {}),
  };
}

function formatStartMs(startMs: number): string {
  const seconds = Math.floor(startMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Readable chip label: prefer source name + page/slide/time when present. */
export function citationChipLabel(citation: {
  label: string;
  page?: number | null;
  startMs?: number | null;
  slideLabel?: string | null;
  sourceName?: string | null;
}): string {
  const name = citation.sourceName?.trim();
  const parts: string[] = [];
  if (name) parts.push(name);
  if (citation.slideLabel) parts.push(`幻灯片 ${citation.slideLabel}`);
  else if (citation.page != null && citation.page > 0) parts.push(`第 ${citation.page} 页`);
  if (citation.startMs != null && citation.startMs >= 0) parts.push(formatStartMs(citation.startMs));
  if (parts.length > 0) return parts.join(" · ");
  return citation.label;
}

export function sourceViewerCopy(input: {
  requestedVersion: number;
  currentVersion: number;
  versionMismatch: boolean;
  page?: number | null;
}): string {
  const pageHint = input.page != null && input.page > 0 ? ` · 第 ${input.page} 页` : "";
  if (!input.versionMismatch) return `正在查看材料${pageHint}`;
  return `正在查看引用时的材料${pageHint}；这份材料之后已有更新。`;
}

export function buildSourceDownloadView(
  sourceId: string,
  requestedVersion: number,
  currentVersion: number,
  page?: number | null,
): SourceDownloadView {
  return {
    url: sourceDownloadHref(sourceId, requestedVersion, page),
    expiresAt: "",
    version: requestedVersion,
    currentVersion,
    versionMismatch: requestedVersion !== currentVersion,
  };
}

function SourcePreviewPane({
  mime,
  previewHref,
  name,
  fillHeight,
  toolsOpen,
  sourceId, version, onExplain,
}: {
  sourceId: string; version: number; onExplain?: (page: number) => void;
  mime: string;
  previewHref: string;
  name: string;
  fillHeight?: boolean;
  toolsOpen?: boolean;
}) {
  const kind = sourcePreviewKind(mime);
  if (kind === "pdf") {
    return <NativePdfPreview href={previewHref} name={name} fillHeight={fillHeight} toolsOpen={toolsOpen} sourceId={sourceId} version={version} onExplain={onExplain} />;
  }
  if (kind === "image") {
    return (
      <img
        src={previewHref}
        alt={`${name} 预览`}
        className="max-h-[calc(100dvh-15rem)] w-full rounded-md border border-line object-contain bg-reader-mat [color-scheme:light]"
      />
    );
  }
  if (kind === "text") {
    return <SourceTextPreview url={previewHref} />;
  }
  return null;
}

export function SourceViewer({
  record,
  latestRecord = record,
  requestedVersion,
  download,
  page,
  hideHeading = false,
  fillHeight = false,
  toolsOpen = false,
  onExplain,
}: {
  record: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState" | "version"> &
    Partial<Pick<SourceRecord, "mime">>;
  latestRecord?: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState" | "version"> &
    Partial<Pick<SourceRecord, "mime">>;
  requestedVersion: number;
  download: SourceDownloadView;
  /** Physical page to prefer in open-original / viewer copy. */
  page?: number | null;
  hideHeading?: boolean;
  fillHeight?: boolean;
  toolsOpen?: boolean;
  onExplain?: (page: number) => void;
}) {
  const currentVersion = Math.max(latestRecord.version, download.currentVersion);
  const versionMismatch = download.versionMismatch || currentVersion !== requestedVersion;
  const copy = sourceViewerCopy({
    requestedVersion,
    currentVersion,
    versionMismatch,
    page,
  });
  // Always same-origin binary link with cookies — never trust a MinIO/presign URL in download.url.
  const href = sourceDownloadHref(record.id, download.version, page);
  const mime = record.mime ?? latestRecord.mime ?? "";
  const previewable = sourcePreviewKind(mime) != null;
  const previewHref = sourcePreviewHref(record.id, download.version, page);
  return (
    <section className={fillHeight ? "flex h-full min-h-0 flex-1 flex-col gap-2 bg-surface" : "space-y-3 bg-surface"} aria-label="材料原件">
      {!hideHeading ? <h2 className="text-base font-semibold text-text">{latestRecord.name}</h2> : null}
      <div className="shrink-0 text-xs text-text-2">
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className={versionMismatch ? "text-warn" : ""}>{copy}</p>
          {!versionMismatch && latestRecord.parseState !== "ready" ? <span role="status">{sourceStatusLabel(latestRecord)}</span> : null}
          <details open={!previewable} className="min-w-0 max-w-full">
            <summary className="min-h-8 cursor-pointer rounded py-1.5 text-xs text-accent focus-visible:ring-2 focus-visible:ring-focus-ring">原件与处理信息</summary>
            <div className="max-h-36 space-y-2 overflow-y-auto overscroll-contain py-2">
              <p>{!versionMismatch ? sourceStatusLabel(latestRecord) : "这里保留引用时的内容；资料库中可查看更新后的材料。"}</p>
              <div className="flex flex-wrap gap-2">
                {previewable ? (
                  <a className={ui.secondary} href={previewHref} target="_blank" rel="noreferrer">
                    在新窗口预览
                    {page != null && page > 0 ? ` · 第 ${page} 页` : ""}
                  </a>
                ) : null}
                <a
                  className={previewable ? ui.secondary : ui.primary}
                  href={href}
                  rel="noreferrer"
                  download
                >
                  打开原件
                  {page != null && page > 0 ? ` · 第 ${page} 页` : ""}
                </a>
              </div>

            </div>
          </details>
        </div>
        <SourceVersionDetails requestedVersion={requestedVersion} currentVersion={currentVersion} />
      </div>
      {previewable ? (
        <div className={fillHeight ? "flex min-h-0 flex-1 flex-col" : "space-y-2"} aria-label="原件预览">
          <SourcePreviewPane sourceId={record.id} version={requestedVersion} onExplain={onExplain} mime={mime} previewHref={previewHref} name={latestRecord.name} fillHeight={fillHeight} toolsOpen={toolsOpen} />
        </div>
      ) : null}
    </section>
  );
}
