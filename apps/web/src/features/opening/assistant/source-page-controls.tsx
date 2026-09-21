"use client";

import type { SourceRecord } from "@aistudy/contracts";

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
    <section className="space-y-3 border-b border-zinc-200 p-3" aria-label="材料与页码">
      <div>
        <h2 className="text-sm font-medium text-zinc-800">指定材料</h2>
        <p className="text-xs text-zinc-500">仅已完成上传且解析就绪的材料可选；解析中的材料不可用于辅导，选文件也不等于选当前页。</p>
        {selectable.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">暂无可指定材料。</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {selectable.map((source) => (
              <li key={source.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedSourceIds.includes(source.id)}
                    disabled={disabled}
                    onChange={() => toggle(source.id)}
                  />
                  <span>{source.name}</span>
                  <span className="text-xs text-zinc-400">{source.parseState}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-700">
        <span className="shrink-0">当前页（可选）</span>
        <input
          type="number"
          min={1}
          className="w-24 rounded-md border border-zinc-300 px-2 py-1"
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
