"use client";

import { RefreshCw, Search } from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { SearchHit } from "@aistudy/domain";
import { PageHeading, ui } from "../../../features/opening/design/ui";
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
    <main className="min-w-0 bg-white"><PageHeading title="全局搜索" description="查找你的笔记和课程。" /><div className="mx-auto max-w-5xl space-y-5 px-5 py-5">

      <form className="flex flex-col gap-3 sm:flex-row" onSubmit={submitSearch} role="search">
        <label className="sr-only" htmlFor="global-search-input">搜索内容</label>
        <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 focus-within:border-emerald-600 focus-within:ring-2 focus-within:ring-zinc-200">
          <Search aria-hidden="true" className="shrink-0 text-zinc-500" size={18} />
          <input
            className="min-w-0 flex-1 bg-transparent py-2 text-sm text-zinc-900 md:py-1.5 outline-none placeholder:text-zinc-500"
            id="global-search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索关键词"
            value={query}
          />
        </div>
        <button className={ui.primary} disabled={!query.trim()} type="submit">
          <Search aria-hidden="true" size={17} />
          搜索
        </button>
      </form>

      <div aria-live="polite">
        {loading ? <p className="border-t border-zinc-200 py-8 text-sm text-zinc-500">正在搜索…</p> : null}
        {error ? <div className="flex items-center gap-3 border-t border-zinc-200 py-8" role="alert"><p className="text-sm text-red-700">{error}</p><button aria-label="重试搜索" className="inline-flex min-h-10 md:min-h-8 items-center gap-2 rounded-md border border-zinc-200 px-3 text-xs text-zinc-900 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600" onClick={() => setReloadToken((value) => value + 1)} title="重试搜索" type="button"><RefreshCw aria-hidden="true" size={14} />重试</button></div> : null}
        {!loading && !error ? <SearchResults hits={hits} query={query} /> : null}
      </div>
    </div></main>
  );
}
