import type { TeachingSourceRef } from "@aistudy/contracts";
import { sourceViewerHref } from "../inbox/source-viewer";

/** Only the exact cited chunks belong to this explanation, not the whole lesson. */
export function TeachingBlockSources({ citedChunkIds, sourceRefs = [] }: {
  citedChunkIds: unknown;
  sourceRefs?: TeachingSourceRef[];
}) {
  const ids = Array.isArray(citedChunkIds)
    ? [...new Set(citedChunkIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))]
    : [];
  if (!ids.length) return null;
  return <details className="pt-1 text-xs leading-6 text-text-2">
    <summary className="cursor-pointer text-text-3">本段依据</summary>
    <ul className="space-y-1 pl-2">
      {ids.map(id => {
        const refs = sourceRefs.filter(ref => ref.chunkId === id);
        if (!refs.length) return <li key={id}>片段 {id} · 无法定位</li>;
        return <li key={id}><ul>{refs.map((ref, index) => {
          const numeric = ref.version == null || (typeof ref.version === "string" && !/^\d+$/.test(ref.version.trim()))
            ? null : Number(ref.version);
          const version = numeric != null && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
          const label = `资料 ${ref.sourceId} · 版本 ${ref.version ?? "未知"}${ref.page != null ? ` · 第 ${ref.page} 页` : ""}`;
          return <li key={index}>{version != null
            ? <a className="break-words text-accent underline underline-offset-4" href={sourceViewerHref(ref.sourceId, version, { page: ref.page })}>{label}</a>
            : <span>{label} · 版本未确认</span>}</li>;
        })}</ul></li>;
      })}
    </ul>
  </details>;
}
