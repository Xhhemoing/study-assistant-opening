"use client";

import type { SourceRecord } from "@aistudy/contracts";
import { inputClass } from "../design/ui";

type Props = {
  sources: SourceRecord[];
  selectedSourceIds: string[];
  currentPage: string;
  onSelectedSourceIdsChange: (ids: string[]) => void;
  onCurrentPageChange: (value: string) => void;
  disabled?: boolean;
};

export function isSourceSelectable(
  source: Pick<SourceRecord, "uploadState" | "parseState">,
): boolean {
  return source.uploadState === "uploaded" && source.parseState === "ready";
}

/** File selection ≠ current-page selection (RU-03). */
export function SourcePageControls({
  sources,
  selectedSourceIds,
  currentPage,
  onSelectedSourceIdsChange,
  onCurrentPageChange,
  disabled,
}: Props) {
  const selectable = sources.filter(isSourceSelectable);

  function toggle(id: string) {
    if (selectedSourceIds.includes(id)) {
      onSelectedSourceIdsChange(selectedSourceIds.filter((x) => x !== id));
    } else {
      onSelectedSourceIdsChange([...selectedSourceIds, id]);
    }
  }

  return (
    <section className="space-y-4" aria-label="材料与页码">
      <div>
        <h2 className="text-xs font-semibold text-zinc-800">指定材料</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">仅已完成上传且解析就绪的材料可选；解析中的材料不可用于辅导，选文件也不等于选当前页。</p>
        {selectable.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">暂无可指定材料。</p>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-200 border-y border-zinc-200">
            {selectable.map((source) => (
              <li key={source.id}>
                <label className="flex min-h-10 items-center gap-2 py-2 text-xs text-zinc-700">
                  <input
                    type="checkbox" className="size-4 shrink-0 accent-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-700"
                    checked={selectedSourceIds.includes(source.id)}
                    disabled={disabled}
                    onChange={() => toggle(source.id)}
                  />
                  <span className="min-w-0 flex-1 break-words">{source.name}</span>
                  <span className="shrink-0 text-[11px] text-emerald-700">就绪</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="flex min-h-10 items-center gap-2 py-2 text-xs text-zinc-700">
        <span className="shrink-0">当前页（可选）</span>
        <input
          type="number"
          min={1}
          className={`${inputClass} w-24`}
          value={currentPage}
          disabled={disabled}
          onChange={(e) => onCurrentPageChange(e.target.value)}
          placeholder="物理页"
          aria-label="当前物理页码"
        />
      </label>
    </section>
  );
}
