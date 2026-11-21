"use client";

import type { WorkspaceEntry } from "@aistudy/ui";
import { BookOpen, ChevronDown, Compass, Library, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { z } from "zod";
import { uuidSchema } from "@aistudy/contracts";
import { ONBOARDING_PATHS, type OnboardingPath } from "../onboarding/onboarding-paths";
import { FirstLearningForm } from "./first-learning-form";

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
  const [draftKey, setDraftKey] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return router.replace("/login");
        if (!response.ok) throw new Error();
        const { user } = z.object({ user: z.object({ id: uuidSchema, workspaceId: uuidSchema }) }).parse(await response.json());
        setDraftKey(`aistudy:first-learning:${user.id}:${user.workspaceId}`);
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
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-4 text-text" role="alert">
      <span className="text-sm text-danger">{error}</span>
      <button className="keycap inline-flex min-h-10 items-center rounded-ctl px-3.5 text-sm font-medium text-text transition-[background-color,box-shadow,transform] duration-150 ease-out-strong hover:bg-surface-2 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" type="button" onClick={() => window.location.reload()}>重试</button>
    </main>
  );
  if (!ready) return <main className="flex min-h-dvh items-center justify-center bg-bg px-4 text-text"><span className="text-sm text-text-2">正在准备你的学习空间</span></main>;

  return (
    <main className="min-h-dvh bg-bg text-text">
      <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-5 px-4 py-10 sm:px-6 lg:px-8">
        <div className="inline-flex items-center gap-2.5 text-sm font-semibold text-text">
          <span className="keycap-ink inline-flex size-8 items-center justify-center rounded-lg text-xs" aria-hidden="true">AI</span>
          <span>AIstudy</span>
        </div>
        <section className="rounded-panel border border-line bg-surface p-5 shadow-card sm:p-7">
          <header className="mb-5 space-y-2">
            <h1 className="font-serif text-2xl font-semibold tracking-tight text-text">从你想学的内容开始</h1>
            <p className="max-w-prose text-sm leading-6 text-text-2">说清想学什么，准备一节具体的学习。也可以跳过设置，直接探索或记笔记。</p>
          </header>
          {draftKey ? <FirstLearningForm draftKey={draftKey} onStarted={href => router.replace(href)} /> : null}
        </section>
        <details className="group rounded-card border border-line bg-surface px-4 py-3 shadow-card">
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between text-sm font-medium text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden"><span>跳过设置，选择其他入口</span><ChevronDown size={15} aria-hidden="true" className="shrink-0 text-text-3 transition-transform duration-150 ease-out-strong group-open:rotate-180" /></summary>
          <div className="mt-2 divide-y divide-line border-t border-line pt-1">
          {ONBOARDING_PATHS.map((path) => {
            const Icon = PATH_ICONS[path.id];
            return (
              <button
                className="flex min-h-18 w-full items-center gap-3.5 rounded-lg px-3 py-3.5 text-left transition-colors duration-150 ease-out-strong hover:bg-surface-2 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
                data-onboarding-path={path.id}
                disabled={choicePending}
                key={path.id}
                onClick={() => void chooseEntry(path.entry, path.href)}
                type="button"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent" aria-hidden="true">
                  <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
                </span>
                <span className="flex flex-col gap-0.5">
                  <strong className="text-sm font-semibold text-text">{path.title}</strong>
                  <span className="text-xs leading-5 text-text-2">{path.description}</span>
                </span>
              </button>
            );
          })}
          </div>
        </details>
        <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm">
          <span className="text-text-2">或者直接进入</span>
          <button
            className="keycap inline-flex min-h-10 items-center gap-2 rounded-ctl px-3.5 text-sm font-medium text-text transition-[background-color,box-shadow,transform] duration-150 ease-out-strong hover:bg-surface-2 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={choicePending}
            onClick={() => void chooseEntry("library", "/opening/library")}
            type="button"
          >
            <Library aria-hidden="true" size={16} />笔记知识库
          </button>
        </div>
      </div>
    </main>
  );
}
