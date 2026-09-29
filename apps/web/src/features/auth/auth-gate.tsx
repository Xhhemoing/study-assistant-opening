"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { loginHrefForReturn } from "./auth-form-model";

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => {
        if (!active) return;
        if (response.ok) setReady(true);
        else if (response.status === 401) router.replace(loginHrefForReturn(`${window.location.pathname}${window.location.search}${window.location.hash}`));
        else setError("暂时无法验证登录状态，请稍后重试。");
      })
      .catch(() => {
        if (active) setError("暂时无法验证登录状态，请检查网络后重试。");
      });
    return () => { active = false; };
  }, [router]);

  if (error) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-white px-5 text-sm text-zinc-600" role="alert">
        <span>{error}</span>
        <button className="inline-flex min-h-10 items-center rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 md:min-h-8" type="button" onClick={() => window.location.reload()}>重试</button>
      </main>
    );
  }

  if (!ready) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-white px-5 text-sm text-zinc-600" aria-live="polite">
        <span className="size-2 rounded-full bg-emerald-700" aria-hidden="true" />
        正在打开学习空间
      </main>
    );
  }

  return children;
}
