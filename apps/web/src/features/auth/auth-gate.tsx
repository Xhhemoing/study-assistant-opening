"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

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
        else if (response.status === 401) router.replace("/login");
        else setError("暂时无法验证登录状态，请稍后重试。");
      })
      .catch(() => {
        if (active) setError("暂时无法验证登录状态，请检查网络后重试。");
      });
    return () => { active = false; };
  }, [router]);

  if (error) {
    return (
      <main className="route-loading" role="alert">
        <span>{error}</span>
        <button className="button" type="button" onClick={() => window.location.reload()}>重试</button>
      </main>
    );
  }

  if (!ready) {
    return (
      <main className="route-loading" aria-live="polite">
        <span className="spinner route-loading__mark" aria-hidden="true" />
        正在打开学习空间
      </main>
    );
  }

  return children;
}