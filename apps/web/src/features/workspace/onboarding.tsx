"use client";

import type { WorkspaceEntry } from "@aistudy/ui";
import { BookOpen, Compass, Library, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const choices: Array<{
  entry: WorkspaceEntry;
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  { entry: "learn", title: "目标学习", description: "围绕考试、课程或阶段目标开始执行。", icon: BookOpen },
  { entry: "explore", title: "自由探索", description: "从问题、资料或一个想法直接开始。", icon: Compass },
  { entry: "library", title: "笔记与知识库", description: "创建笔记，积累长期可连接的知识。", icon: Library },
];

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

  async function choose(entry: WorkspaceEntry) {
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
      router.replace(`/${entry}`);
    } catch {
      setError("暂时无法保存默认首页，请检查网络后重试。");
    } finally {
      setChoicePending(false);
    }
  }

  if (error) return (
    <main className="route-loading" role="alert">
      <span>{error}</span>
      <button className="button" type="button" onClick={() => window.location.reload()}>重试</button>
    </main>
  );
  if (!ready) return <main className="route-loading">正在准备你的学习空间</main>;

  return (
    <main className="onboarding-page">
      <header className="onboarding-header">
        <span className="auth-brand">AIstudy</span>
        <h1>你想从哪里开始？</h1>
        <p>这里只决定默认首页。之后可以直接在 Learn、Explore 和 Library 之间切换，也不需要先创建课程或目标。</p>
      </header>
      <div className="entry-choices">
        {choices.map(({ entry, title, description, icon: Icon }) => (
          <button
            key={entry}
            className="entry-choice"
            type="button"
            disabled={choicePending}
            onClick={() => choose(entry)}
          >
            <Icon aria-hidden="true" size={26} strokeWidth={1.7} />
            <strong>{title}</strong>
            <span>{description}</span>
          </button>
        ))}
      </div>
    </main>
  );
}