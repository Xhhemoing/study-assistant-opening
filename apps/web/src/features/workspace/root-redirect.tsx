"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type PreferenceResponse = { defaultEntry: "learn" | "explore" | "library" | null };

export function RootRedirect() {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let active = true;
    fetch("/api/workspace/preferences", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (response.status === 503) {
          throw new Error("service-unavailable");
        }
        if (!response.ok) throw new Error();
        const body = await response.json() as PreferenceResponse;
        router.replace(`/${body.defaultEntry ?? "learn"}`);
      })
      .catch(() => {
        if (active) setError("暂时无法连接学习空间，请检查网络后重试。");
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [router]);

  if (error) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-white px-5 text-sm text-zinc-600" role="alert">
        <span>{error}</span>
        <button className="inline-flex min-h-10 items-center rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 md:min-h-8" type="button" onClick={() => window.location.reload()}>重试</button>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-white px-5 text-sm text-zinc-600" aria-live="polite">
      <span className="size-2 rounded-full bg-emerald-700" aria-hidden="true" />
      正在进入 AIstudy
    </main>
  );
}
