"use client";

import type { WorkspaceEntry } from "@aistudy/ui";
import { BookOpen, Compass, Library, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ONBOARDING_PATHS, type OnboardingPath } from "../onboarding/onboarding-paths";

const PATH_ICONS: Record<OnboardingPath["id"], LucideIcon> = {
  "free-exploration": Compass,
  "goal-course": BookOpen,
  "knowledge-course": Library,
  "promote-exploration": Compass,
};

export function Onboarding() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [choicePending, setChoicePending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return router.replace("/login");
        if (!response.ok) throw new Error();
        await response.json();
        setReady(true);
      })
      .catch(() => setError("暂时无法准备学习空间，请检查网络后重试。"));
  }, [router]);

  async function chooseEntry(entry: WorkspaceEntry, href: string) {
    setChoicePending(true);
    setError("");
    try {
      const response = await fetch("/api/workspace/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultEntry: entry }),
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      if (!response.ok) throw new Error();
      router.replace(href);
    } catch {
      setError("暂时无法保存默认首页，请检查网络后重试。");
    } finally {
      setChoicePending(false);
    }
  }

  if (error) return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4" role="alert">
      <span className="text-sm text-red-700">{error}</span>
      <button className="inline-flex min-h-10 items-center rounded-md border border-zinc-200 px-3 text-sm text-zinc-800 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" type="button" onClick={() => window.location.reload()}>重试</button>
    </main>
  );
  if (!ready) return <main className="flex min-h-screen items-center justify-center px-4"><span className="text-sm text-zinc-500">正在准备你的学习空间</span></main>;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-6 px-4 py-10 sm:px-6 lg:px-8">
      <header className="space-y-3">
        <span className="text-sm font-semibold text-emerald-700">AIstudy</span>
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-zinc-800">你想从哪里开始？</h1>
        <p className="max-w-prose text-sm leading-6 text-zinc-500">这些只是起点，之后可以随时在 学习、探索和知识库 之间切换，也不需要先创建课程或目标。</p>
      </header>
      <div className="divide-y divide-zinc-200 border-y border-zinc-200">
        {ONBOARDING_PATHS.map((path) => {
          const Icon = PATH_ICONS[path.id];
          return (
            <button
              className="flex min-h-20 w-full items-center gap-4 px-3 py-4 text-left transition-colors duration-150 hover:bg-zinc-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-onboarding-path={path.id}
              disabled={choicePending}
              key={path.id}
              onClick={() => void chooseEntry(path.entry, path.href)}
              type="button"
            >
              <Icon aria-hidden="true" className="text-emerald-700" size={20} strokeWidth={1.7} />
              <span className="flex flex-col gap-1">
                <strong className="text-sm font-semibold text-zinc-800">{path.title}</strong>
                <span className="text-xs leading-5 text-zinc-500">{path.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-4 text-sm">
        <span className="text-zinc-500">或者直接进入</span>
        <button
          className="inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm text-zinc-800 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={choicePending}
          onClick={() => void chooseEntry("library", "/library")}
          type="button"
        >
          <Library aria-hidden="true" size={16} />笔记知识库
        </button>
      </div>
    </main>
  );
}
