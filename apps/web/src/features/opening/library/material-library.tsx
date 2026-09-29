"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { LoadError, LoadingRows, ui } from "../design/ui";
import { InboxPanel } from "../inbox/inbox-panel";

export function MaterialLibrary({ api }: { api: OpeningApi }) {
  const [sources, setSources] = useState<SourceRecord[]>([]), [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const mounted = useRef(true);
  const refresh = useCallback(async () => { const next = await api.listSources(); if (mounted.current) { setSources(next); setError(""); } }, [api]);
  const load = useCallback(async () => { setLoading(true); setError(""); try { await refresh(); } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "材料暂时无法读取"); } finally { if (mounted.current) setLoading(false); } }, [refresh]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs leading-6 text-zinc-500">保留原件与版本；解析就绪后可作为回答来源。</p><label className="relative w-full sm:w-72"><Search size={13} className="pointer-events-none absolute left-2.5 top-3.5 text-zinc-500 md:top-2.5" aria-hidden="true" /><input aria-label="搜索材料名称" className={`${ui.input} pl-8`} placeholder="搜索材料名称…" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>{loading ? <LoadingRows label="正在读取材料…" /> : error ? <LoadError message={error} onRetry={() => void load()} /> : <div id="upload" className="scroll-mt-4"><InboxPanel api={api} sources={sources} onChanged={refresh} filter={query} /></div>}</div>;
}
