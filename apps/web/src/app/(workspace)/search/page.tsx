"use client";

import { RefreshCw, Search } from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { SearchHit } from "@aistudy/domain";
import { SearchResults } from "../../../features/search/search-results";
import { createSearchApi } from "../../../features/search/search-api";

export default function SearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchApi = useMemo(() => createSearchApi(), []);
  const urlQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => setQuery(urlQuery), [urlQuery]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setLoading(false);
      setError("");
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    setHits([]);
    searchApi.search(query, 40)
      .then((nextHits) => {
        if (active) setHits(nextHits);
      })
      .catch(() => {
        if (active) setError("搜索暂时不可用，请稍后再试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query, reloadToken, searchApi]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = query.trim();
    router.replace(nextQuery ? `/search?q=${encodeURIComponent(nextQuery)}` : "/search", { scroll: false });
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">全局搜索</h1>
        <p className="max-w-prose text-sm leading-6 text-text-dim">从一个入口查找你的笔记和课程。</p>
      </header>

      <form className="flex flex-col gap-3 sm:flex-row" onSubmit={submitSearch} role="search">
        <label className="sr-only" htmlFor="global-search-input">搜索内容</label>
        <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-line bg-surface px-3 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30">
          <Search aria-hidden="true" className="shrink-0 text-text-dim" size={18} />
          <input
            className="min-w-0 flex-1 bg-transparent py-3 text-sm text-text outline-none placeholder:text-text-dim"
            id="global-search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索关键词"
            value={query}
          />
        </div>
        <button className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-ink transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={!query.trim()} type="submit">
          <Search aria-hidden="true" size={17} />
          搜索
        </button>
      </form>

      <div aria-live="polite">
        {loading ? <p className="border-t border-line py-8 text-sm text-text-dim">正在搜索…</p> : null}
        {error ? <div className="flex items-center gap-3 border-t border-line py-8" role="alert"><p className="text-sm text-danger">{error}</p><button aria-label="重试搜索" className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line px-3 text-xs text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setReloadToken((value) => value + 1)} title="重试搜索" type="button"><RefreshCw aria-hidden="true" size={14} />重试</button></div> : null}
        {!loading && !error ? <SearchResults hits={hits} query={query} /> : null}
      </div>
    </div>
  );
}
