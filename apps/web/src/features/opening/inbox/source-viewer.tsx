import type { SourceRecord } from "@aistudy/contracts";
import { sourceStatusLabel } from "./upload-state";
import { ui } from "../design/ui";

export type SourceDownloadView = {
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

export function SourceViewer({
  record,
  requestedVersion,
  download,
}: {
  record: Pick<SourceRecord, "name" | "uploadState" | "parseState" | "version">;
  requestedVersion: number;
  download: SourceDownloadView;
}) {
  const copy = sourceViewerCopy({
    requestedVersion,
    currentVersion: download.currentVersion,
    versionMismatch: download.versionMismatch,
  });
  return (
    <section className="space-y-3 border-t border-zinc-200 bg-white py-4">
      <h2 className="text-base font-semibold text-zinc-950">{record.name}</h2>
      <p className="text-sm text-zinc-700">{sourceStatusLabel(record)}</p>
      <p className="text-sm text-amber-800">{copy}</p>
      <a
        className={ui.primary}
        href={download.url}
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
