"use client";

import { Command, RefreshCw, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SearchHit } from "@aistudy/domain";
import { ui } from "../opening/design/ui";
import { SEARCH_DEBOUNCE_MS, filterPaletteCommands, getNextPaletteIndex, getPaletteKeyAction } from "./command-palette-model";
import { searchHitHref, searchHitTypeLabel } from "./search-results-model";
import { createSearchApi } from "./search-api";

interface PaletteOption { id: string; label: string; description: string; href: string; kind: "page" | "command" | "result" }
function buildOptions(query: string, hits: SearchHit[]): PaletteOption[] {
  return [
    ...filterPaletteCommands(query),
    ...hits.map((hit) => ({ id: `result-${hit.type}-${hit.id}`, label: hit.title,
      description: `${searchHitTypeLabel(hit.type)} · ${hit.snippet || "暂无摘要"}${hit.lifecycle ? ` · ${hit.lifecycle}` : ""}${hit.courseMemberships?.length ? ` · ${hit.courseMemberships.map((course) => course.title).join("、")}` : ""}`,
      href: searchHitHref(hit), kind: "result" as const })),
  ];
}

export function CommandPalette({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const router = useRouter();
  const searchApi = useMemo(() => createSearchApi(), []);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const options = useMemo(() => buildOptions(query, hits), [query, hits]);

  useEffect(() => {
    function handleGlobalKeyDown(event: globalThis.KeyboardEvent) {
      if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); onOpen(); }
    }
    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown);
  }, [onOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery(""); setHits([]); setActiveIndex(0); setError("");
    dialog.showModal();
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      dialog.close();
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !query.trim()) { setHits([]); setLoading(false); setError(""); return; }
    let active = true;
    setLoading(true); setError(""); setHits([]);
    const timer = window.setTimeout(() => {
      searchApi.search(query, 12)
        .then((nextHits) => { if (active) setHits(nextHits); })
        .catch(() => { if (active) setError("内容搜索暂时不可用，请稍后重试。页面导航仍可使用。"); })
        .finally(() => { if (active) setLoading(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, query, retryToken, searchApi]);

  useEffect(() => { setActiveIndex((current) => Math.max(0, Math.min(current, Math.max(options.length - 1, 0)))); }, [options.length]);
  useEffect(() => {
    const option = options[activeIndex];
    if (open && option) document.getElementById(`command-option-${option.id}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, options]);
  function selectOption(index: number) { const option = options[index]; if (!option) return; onClose(); router.push(option.href); }
  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    const action = getPaletteKeyAction(event.key, event.nativeEvent.isComposing);
    if (action === "none") return;
    event.preventDefault();
    if (action === "close") return onClose();
    if (action === "select") return selectOption(activeIndex);
    setActiveIndex((current) => getNextPaletteIndex(current, action, options.length));
  }
  if (!open) return null;
  return <dialog ref={dialogRef} aria-labelledby="command-palette-title" aria-modal="true" role="dialog" className="fixed inset-x-4 bottom-auto top-[10dvh] m-0 mx-auto max-h-[80dvh] w-[calc(100%_-_2rem)] max-w-2xl overflow-hidden rounded-lg border border-zinc-200 bg-white p-0 text-zinc-800 shadow-xl shadow-zinc-950/15 outline-none backdrop:bg-zinc-950/30" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <div className="flex min-h-12 items-center gap-3 border-b border-zinc-200 px-4">
      <Search aria-hidden="true" className="shrink-0 text-zinc-500" size={17} /><h2 id="command-palette-title" className="sr-only">快捷导航与内容搜索</h2>
      <input aria-activedescendant={options[activeIndex] ? `command-option-${options[activeIndex].id}` : undefined} ref={inputRef} aria-controls="command-palette-options" aria-expanded="true" aria-label="搜索页面、笔记和课程" autoComplete="off" className="min-h-12 min-w-0 flex-1 bg-transparent text-sm text-zinc-800 outline-none placeholder:text-zinc-500" onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={handleKeyDown} placeholder="搜索页面、笔记和课程" role="combobox" value={query} />
      <span className="hidden items-center gap-1 text-xs text-zinc-400 sm:flex"><Command aria-hidden="true" size={12} />K</span><button aria-label="关闭搜索" className={ui.icon} onClick={onClose} type="button"><X aria-hidden="true" size={16} /></button>
    </div>
    <div className="max-h-[60dvh] overflow-y-auto p-2">
      <p className="px-3 py-2 text-xs text-zinc-500">{query.trim() ? "页面、操作与内容结果" : "页面与快捷操作"}</p>
      <div id="command-palette-options" role="listbox" aria-label="搜索选项">{options.map((option, index) => <button aria-selected={activeIndex === index} className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700 motion-reduce:transition-none ${activeIndex === index ? "bg-emerald-50" : "hover:bg-zinc-50"}`} id={`command-option-${option.id}`} key={option.id} onClick={() => selectOption(index)} onMouseEnter={() => setActiveIndex(index)} role="option" tabIndex={-1} type="button"><span className="min-w-0"><span className="block truncate text-sm font-medium text-zinc-800">{option.label}</span><span className="mt-0.5 block truncate text-xs text-zinc-500">{option.description}</span></span><span className="shrink-0 text-[10px] text-zinc-500">{option.kind === "page" ? "页面" : option.kind === "command" ? "操作" : "内容"}</span></button>)}</div>
      {loading ? <p className="px-3 py-3 text-xs text-zinc-500" role="status">正在搜索内容…</p> : null}
      {error ? <div className="flex items-center justify-between gap-3 px-3 py-3" role="alert"><p className="text-xs leading-6 text-red-700">{error}</p><button aria-label="重试搜索" className={ui.icon} onClick={() => setRetryToken((value) => value + 1)} type="button"><RefreshCw aria-hidden="true" size={15} /></button></div> : null}
      {query.trim() && !loading && !error && options.length === 0 ? <p className="px-3 py-6 text-center text-sm text-zinc-500" role="status">没有匹配的页面或内容</p> : null}
    </div>
    <p className="border-t border-zinc-100 px-4 py-2 text-[10px] text-zinc-500">上下键选择 · Enter 打开 · Esc 关闭</p>
  </dialog>;
}
