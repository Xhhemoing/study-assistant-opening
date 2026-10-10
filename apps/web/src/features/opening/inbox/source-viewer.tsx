import type { SourceRecord } from "@aistudy/contracts";
import { z } from "zod";
import { sourceStatusLabel } from "./upload-state";
import { ui } from "../design/ui";

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

/** Same-origin binary download; optional `#page=` for PDF viewers that honor it. */
export function sourceDownloadHref(sourceId: string, version: number, page?: number | null): string {
  const base = `/api/opening/sources/${sourceId}/download?version=${version}`;
  return page != null && page > 0 ? `${base}#page=${page}` : base;
}

export function parseSourceViewerSearchParams(input: {
  source?: string;
  version?: string;
  page?: string;
  startMs?: string;
  slide?: string;
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
  return {
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
  if (!input.versionMismatch) return `正在查看 v${input.requestedVersion}${pageHint}`;
  return `正在查看 v${input.requestedVersion}${pageHint}，不是当前版本 v${input.currentVersion}`;
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

export function SourceViewer({
  record,
  latestRecord = record,
  requestedVersion,
  download,
  page,
}: {
  record: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState" | "version">;
  latestRecord?: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState" | "version">;
  requestedVersion: number;
  download: SourceDownloadView;
  /** Physical page to prefer in open-original / viewer copy. */
  page?: number | null;
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
  return (
    <section className="space-y-3 border-t border-zinc-200 bg-white py-4">
      <h2 className="text-base font-semibold text-zinc-950">{latestRecord.name}</h2>
      <p className="text-sm text-zinc-700">{!versionMismatch ? sourceStatusLabel(latestRecord) : "这是历史版本，处理状态以当前版本为准"}</p>
      <p className="text-sm text-amber-800">{copy}</p>
      <a
        className={ui.primary}
        href={href}
        rel="noreferrer"
      >
        打开原件 v{download.version}
        {page != null && page > 0 ? ` · 第 ${page} 页` : ""}
      </a>
      <div className="overflow-x-auto text-sm text-zinc-800">
        <p>页面标签随原件查看。公式可横向滚动。</p>
      </div>
    </section>
  );
}
