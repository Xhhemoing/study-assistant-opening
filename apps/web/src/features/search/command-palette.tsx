"use client";

import { Command, RefreshCw, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SearchHit } from "@aistudy/domain";
import { getFocusTrapTarget } from "@aistudy/ui";
import { useStudyProvider } from "../../lib/data/react";
import {
  PALETTE_COMMANDS,
  SEARCH_DEBOUNCE_MS,
  getNextPaletteIndex,
  getPaletteKeyAction,
} from "./command-palette-model";
import { searchHitHref, searchHitTypeLabel } from "./search-results-model";

interface PaletteOption {
  id: string;
  label: string;
  description: string;
  href: string;
  kind: "command" | "result";
}

function buildOptions(hits: SearchHit[]): PaletteOption[] {
  return [
    ...PALETTE_COMMANDS.map((command) => ({ ...command, kind: "command" as const })),
    ...hits.map((hit) => ({
      id: `result-${hit.type}-${hit.id}`,
      label: hit.title,
      description: `${searchHitTypeLabel(hit.type)} · ${hit.snippet || "暂无摘要"}`,
      href: searchHitHref(hit),
      kind: "result" as const,
    })),
  ];
}

export function CommandPalette({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const provider = useStudyProvider();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const options = useMemo(() => buildOptions(hits), [hits]);

  useEffect(() => {
    function handleGlobalKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      }
      if (open && event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown);
  }, [onClose, onOpen, open]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setHits([]);
    setActiveIndex(0);
    setError("");
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialogRef.current) return;
      const elements = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button, input, [href], [tabindex]")).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
      if (elements.length === 0) return;
      const activeIndex = elements.indexOf(document.activeElement as HTMLElement);
      const targetIndex = getFocusTrapTarget(activeIndex, event.shiftKey ? "backward" : "forward", elements.length);
      if (targetIndex !== null) {
        event.preventDefault();
        elements[targetIndex]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocusRef.current && document.contains(previousFocusRef.current)) previousFocusRef.current.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !provider || !query.trim()) {
      setHits([]);
      setLoading(false);
      setError("");
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    setHits([]);
    const timer = window.setTimeout(() => {
      provider.searchAll(query, 12)
        .then((nextHits) => {
          if (active) setHits(nextHits);
        })
        .catch(() => {
          if (active) setError("搜索暂时不可用，请稍后再试。");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, provider, query, retryToken]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(options.length - 1, 0)));
  }, [options.length]);

  function selectOption(index: number) {
    const option = options[index];
    if (!option) return;
    onClose();
    router.push(option.href);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    const action = getPaletteKeyAction(event.key);
    if (action === "none") return;
    event.preventDefault();
    if (action === "close") return onClose();
    if (action === "select") return selectOption(activeIndex);
    setActiveIndex((current) => getNextPaletteIndex(current, action, options.length));
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/75 px-4 py-[10vh] sm:px-6"
      data-command-palette-backdrop="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby="command-palette-title"
        aria-modal="true"
        className="mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-surface shadow-2xl shadow-ink/50"
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search aria-hidden="true" className="shrink-0 text-text-dim" size={18} />
          <h2 id="command-palette-title" className="sr-only">全局搜索</h2>
          <input
            aria-activedescendant={options[activeIndex] ? `command-option-${options[activeIndex].id}` : undefined}
            ref={inputRef}
            aria-controls="command-palette-options"
            aria-label="搜索笔记和操作"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent py-4 text-sm text-text outline-none placeholder:text-text-dim"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索笔记、探索、卡片或练习"
            value={query}
          />
          <span className="hidden items-center gap-1 text-xs text-text-dim sm:flex"><Command aria-hidden="true" size={13} />K</span>
          <button aria-label="关闭搜索" className="rounded-md p-1.5 text-text-dim hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={onClose} type="button">
            <X aria-hidden="true" size={17} />
          </button>
        </div>

        <div className="max-h-[min(28rem,60vh)] overflow-y-auto p-2" id="command-palette-options" role="listbox" aria-label="搜索选项">
          <p className="px-3 pb-2 pt-1 text-xs font-medium uppercase tracking-[0.08em] text-text-dim">快捷操作</p>
          {options.map((option, index) => (
            <button
              aria-selected={activeIndex === index}
              className={`flex w-full items-start justify-between gap-4 rounded-lg px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${activeIndex === index ? "bg-surface-2" : "hover:bg-surface-2/70"}`}
              id={`command-option-${option.id}`}
              key={option.id}
              onClick={() => selectOption(index)}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
              type="button"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text">{option.label}</span>
                <span className="mt-0.5 block truncate text-xs text-text-dim">{option.description}</span>
              </span>
              {option.kind === "command" ? <span className="shrink-0 text-xs text-text-dim">操作</span> : null}
            </button>
          ))}
          {loading ? <p className="px-3 py-3 text-sm text-text-dim">正在搜索…</p> : null}
          {error ? <div className="flex items-center justify-between gap-3 px-3 py-3" role="alert"><p className="text-sm text-danger">{error}</p><button aria-label="重试搜索" className="inline-grid size-9 shrink-0 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setRetryToken((value) => value + 1)} title="重试搜索" type="button"><RefreshCw aria-hidden="true" size={15} /></button></div> : null}
          {query.trim() && !loading && !error && hits.length === 0 ? <p className="px-3 py-3 text-sm text-text-dim">没有匹配内容</p> : null}
        </div>
      </section>
    </div>
  );
}
