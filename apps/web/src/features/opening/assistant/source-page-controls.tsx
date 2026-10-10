"use client";

import { useState } from "react";
import type { SourceRecord } from "@aistudy/contracts";
import { inputClass } from "../design/ui";
import { MAX_ASSISTANT_SOURCE_IDS, toggleSelectedSourceId } from "./course-source-selection";

type Props = {
  sources: SourceRecord[];
  selectedSourceIds: string[];
  currentPage: string;
  onSelectedSourceIdsChange: (ids: string[]) => void;
  onCurrentPageChange: (value: string) => void;
  disabled?: boolean;
  /**
   * When set (course-bound picker), default list = ready sources in membership;
   * optional expand shows other ready workspace materials (Package B).
   */
  membershipSourceIds?: ReadonlySet<string> | null;
};

export function isSourceSelectable(
  source: Pick<SourceRecord, "uploadState" | "parseState">,
): boolean {
  return source.uploadState === "uploaded" && source.parseState === "ready";
}

function SourceCheckboxList({
  items,
  selectedSourceIds,
  disabled,
  onToggle,
}: {
  items: SourceRecord[];
  selectedSourceIds: string[];
  disabled?: boolean;
  onToggle: (id: string) => void;
}) {
  if (items.length === 0) {
    return <p className="mt-2 text-sm text-zinc-500">暂无可指定材料。</p>;
  }
  return (
    <ul className="mt-3 divide-y divide-zinc-200 border-y border-zinc-200">
      {items.map((source) => (
        <li key={source.id}>
          <label className="flex min-h-10 items-center gap-2 py-2 text-xs text-zinc-700">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-700"
              checked={selectedSourceIds.includes(source.id)}
              disabled={disabled || (!selectedSourceIds.includes(source.id) && selectedSourceIds.length >= MAX_ASSISTANT_SOURCE_IDS)}
              onChange={() => onToggle(source.id)}
            />
            <span className="min-w-0 flex-1 break-words">{source.name}</span>
            <span className="shrink-0 text-[11px] text-emerald-700">就绪</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** File selection ≠ current-page selection (RU-03). */
export function SourcePageControls({
  sources,
  selectedSourceIds,
  currentPage,
  onSelectedSourceIdsChange,
  onCurrentPageChange,
  disabled,
  membershipSourceIds = null,
}: Props) {
  const [showWorkspaceOthers, setShowWorkspaceOthers] = useState(false);
  const selectable = sources.filter(isSourceSelectable);
  const courseScoped = membershipSourceIds != null;
  const membershipReady = courseScoped
    ? selectable.filter((source) => membershipSourceIds.has(source.id))
    : selectable;
  const workspaceOthers = courseScoped
    ? selectable.filter((source) => !membershipSourceIds.has(source.id))
    : [];

  function toggle(id: string) {
    onSelectedSourceIdsChange(toggleSelectedSourceId(selectedSourceIds, id));
  }

  return (
    <section className="space-y-4" aria-label="材料与页码">
      <div>
        <h2 className="text-xs font-semibold text-zinc-800">指定材料</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          {courseScoped
            ? "默认显示本课已挂接且解析就绪的材料；可选最多 32 份。选文件不等于选当前页。"
            : "仅已完成上传且解析就绪的材料可选；解析中的材料不可用于辅导，选文件也不等于选当前页。"}
        </p>
        {selectedSourceIds.length >= MAX_ASSISTANT_SOURCE_IDS ? (
          <p className="mt-2 text-xs text-amber-800" role="status">已选满 {MAX_ASSISTANT_SOURCE_IDS} 份材料。</p>
        ) : null}
        <SourceCheckboxList
          items={membershipReady}
          selectedSourceIds={selectedSourceIds}
          disabled={disabled}
          onToggle={toggle}
        />
        {courseScoped && workspaceOthers.length > 0 ? (
          <div className="mt-3">
            <button
              type="button"
              className="text-xs font-medium text-emerald-800 underline decoration-emerald-300 underline-offset-2 focus-visible:ring-2 focus-visible:ring-emerald-700"
              aria-expanded={showWorkspaceOthers}
              onClick={() => setShowWorkspaceOthers((value) => !value)}
            >
              {showWorkspaceOthers ? "收起工作区其他材料" : "显示工作区其他材料"}
            </button>
            {showWorkspaceOthers ? (
              <SourceCheckboxList
                items={workspaceOthers}
                selectedSourceIds={selectedSourceIds}
                disabled={disabled}
                onToggle={toggle}
              />
            ) : null}
          </div>
        ) : null}
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
