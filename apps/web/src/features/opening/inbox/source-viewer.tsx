import type { SourceRecord } from "@aistudy/contracts";
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

export function sourceDownloadHref(sourceId: string, version: number): string {
  return `/api/opening/sources/${sourceId}/download?version=${version}`;
}

export function sourceViewerCopy(input: {
  requestedVersion: number;
  currentVersion: number;
  versionMismatch: boolean;
}): string {
  if (!input.versionMismatch) return `正在查看 v${input.requestedVersion}`;
  return `正在查看 v${input.requestedVersion}，不是当前版本 v${input.currentVersion}`;
}

export function buildSourceDownloadView(
  sourceId: string,
  requestedVersion: number,
  currentVersion: number,
): SourceDownloadView {
  return {
    url: sourceDownloadHref(sourceId, requestedVersion),
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
}: {
  record: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState" | "version">;
  latestRecord?: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState" | "version">;
  requestedVersion: number;
  download: SourceDownloadView;
}) {
  const currentVersion = Math.max(latestRecord.version, download.currentVersion);
  const versionMismatch = download.versionMismatch || currentVersion !== requestedVersion;
  const copy = sourceViewerCopy({
    requestedVersion,
    currentVersion,
    versionMismatch,
  });
  // Always same-origin binary link with cookies — never trust a MinIO/presign URL in download.url.
  const href = sourceDownloadHref(record.id, download.version);
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
      </a>
      <div className="overflow-x-auto text-sm text-zinc-800">
        <p>页面标签随原件查看。公式可横向滚动。</p>
      </div>
    </section>
  );
}
