"use client";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { sourceRecordSchema, type SourceRecord } from "@aistudy/contracts";
import { ui } from "../opening/design/ui";

export function FirstLearningMaterials({ selected, disabled, onChange }: {
  selected: string[]; disabled: boolean; onChange: (ids: string[]) => void;
}) {
  const [rows, setRows] = useState<SourceRecord[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    fetch("/api/opening/sources", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("materials unavailable");
        const sources = z.array(sourceRecordSchema).parse(await response.json());
        if (!controller.signal.aborted) {
          setRows(sources.filter(source => source.uploadState === "uploaded" && source.parseState === "ready"));
          setState("ready");
        }
      }).catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [reload]);
  return <details className="group rounded-ctl border border-line bg-surface-2/35 px-3.5 py-2">
    <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between py-1.5 text-sm font-medium tabular-nums text-text-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden"><span>已有学习材料（可选）{selected.length ? ` · 已选 ${selected.length} 份` : ""}</span><ChevronDown size={15} aria-hidden="true" className="shrink-0 text-text-3 transition-transform duration-150 ease-out-strong group-open:rotate-180" /></summary>
    <div className="mt-1 space-y-2 border-t border-line pb-1 pt-2.5">
      {state === "loading" ? <p className="text-sm text-text-3" role="status">正在读取已解析材料…</p> : null}
      {state === "error" ? <div className="text-sm text-text-2" role="status">材料暂时无法读取；可以先填写目标。<button type="button" className={ui.quiet} disabled={disabled} onClick={() => setReload(value => value + 1)}>重新读取</button></div> : null}
      {state === "ready" && !rows.length ? <p className="text-sm leading-6 text-text-3">暂无已解析材料。可以先开始，或稍后到资料库上传。</p> : null}
      {rows.map(source => <label key={source.id} className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 text-sm text-text hover:bg-surface-2/60">
        <input type="checkbox" className="size-4 rounded accent-accent" checked={selected.includes(source.id)} disabled={disabled || (selected.length >= 32 && !selected.includes(source.id))}
          onChange={event => onChange(event.target.checked ? [...selected, source.id] : selected.filter(id => id !== source.id))} />
        <span className="min-w-0 break-words">{source.name}</span>
      </label>)}
      {selected.length ? <button type="button" className={ui.quiet} disabled={disabled} onClick={() => onChange([])}>清除所选材料</button> : null}
    </div>
  </details>;
}
