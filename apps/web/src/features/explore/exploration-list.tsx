"use client";

import { ArrowUp, FileText, Lightbulb, Link as LinkIcon, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Exploration } from "@aistudy/contracts";
import { EmptyState, ui } from "../opening/design/ui";
import { useStudyProvider } from "../../lib/data/react";
import {
  EXPLORATION_STARTERS,
  explorationPath,
  explorationStatusLabel,
} from "./exploration-list-model";

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function StarterIcon({ id }: { id: (typeof EXPLORATION_STARTERS)[number]["id"] }) {
  if (id === "concept") return <Lightbulb aria-hidden="true" size={15} />;
  if (id === "material") return <FileText aria-hidden="true" size={15} />;
  return <LinkIcon aria-hidden="true" size={15} />;
}

function ExplorationStatus({ status }: { status: Exploration["status"] }) {
  const open = status === "open";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${open ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${open ? "bg-emerald-600" : "bg-zinc-400"}`} />
      {explorationStatusLabel(status)}
    </span>
  );
}

export function ExplorationLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <section className="space-y-3 border-y border-zinc-200 py-8" role="alert"><p className="text-sm text-red-700">{message}</p><button className={ui.secondary} onClick={onRetry} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button></section>;
}

export function ExplorationList() {
  const router = useRouter();
  const provider = useStudyProvider();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [explorations, setExplorations] = useState<Exploration[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [createError, setCreateError] = useState("");

  const loadExplorations = useCallback(async () => {
    if (!provider) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError("");
    try {
      setExplorations(await provider.listExplorations());
    } catch {
      setLoadError("探索列表加载失败，请重试。");
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void loadExplorations();
  }, [loadExplorations]);

  async function createExploration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!provider || !nextTitle || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const exploration = await provider.createExploration(nextTitle);
      router.push(explorationPath(exploration.id));
    } catch {
      setCreateError("探索创建失败，请稍后再试。");
    } finally {
      setCreating(false);
    }
  }

  function chooseStarter(prompt: string) {
    setTitle(prompt);
    inputRef.current?.focus();
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-zinc-900">自由探索</h1>
        <p className="max-w-prose text-sm leading-7 text-zinc-500">从一个问题、一个想法或一段资料出发，先把值得追问的方向留下来。</p>
      </header>

      <section aria-labelledby="new-exploration-heading" className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-900" id="new-exploration-heading">开始一个探索</h2>
        <form className="flex flex-col gap-3 sm:flex-row" onSubmit={createExploration}>
          <label className="sr-only" htmlFor="exploration-title">探索主题</label>
          <input
            ref={inputRef}
            className="min-h-10 md:min-h-8 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none placeholder:text-zinc-500 focus:border-emerald-600 focus:ring-2 focus:ring-zinc-200"
            id="exploration-title"
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="你想弄清楚什么？"
            value={title}
          />
          <button className={ui.primary} disabled={!title.trim() || creating} type="submit">
            <ArrowUp aria-hidden="true" size={17} />
            {creating ? "创建中" : "开始探索"}
          </button>
        </form>
        {createError ? <p className="text-sm text-red-700" role="alert">{createError}</p> : null}
        <div aria-label="探索起点" className="flex flex-wrap gap-2">
          {EXPLORATION_STARTERS.map((starter) => (
            <button
              className={ui.secondary}
              key={starter.id}
              onClick={() => chooseStarter(starter.prompt)}
              type="button"
            >
              <StarterIcon id={starter.id} />
              {starter.label}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="exploration-list-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-semibold text-zinc-900" id="exploration-list-heading">我的探索</h2>
          {!loading && !loadError ? <span className="text-xs text-zinc-500">{explorations.length} 个</span> : null}
        </div>
        {loading ? <p className="border-y border-zinc-200 py-8 text-sm text-zinc-500">正在加载探索…</p> : null}
        {loadError ? <ExplorationLoadError message={loadError} onRetry={() => void loadExplorations()} /> : null}
        {!loading && !loadError && explorations.length === 0 ? (
          <EmptyState title="还没有探索" description="输入一个主题，或先选择上面的起点。" />
        ) : null}
        {!loading && !loadError && explorations.length > 0 ? (
          <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
            {explorations.map((exploration) => (
              <li key={exploration.id}>
                <Link className="flex items-center justify-between gap-4 px-3 py-3 transition-colors duration-150 motion-reduce:transition-none hover:bg-zinc-50 focus-visible:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600" href={explorationPath(exploration.id)}>
                  <span className="min-w-0 space-y-1">
                    <span className="block truncate text-sm font-medium text-zinc-900">{exploration.title}</span>
                    <span className="block text-xs text-zinc-500">更新于 {formatUpdatedAt(exploration.updatedAt)}</span>
                  </span>
                  <ExplorationStatus status={exploration.status} />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
