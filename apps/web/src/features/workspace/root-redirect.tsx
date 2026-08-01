"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type PreferenceResponse = { defaultEntry: "learn" | "explore" | "library" | null };

export function RootRedirect() {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/workspace/preferences", { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (!response.ok) throw new Error();
        const body = await response.json() as PreferenceResponse;
        router.replace(`/${body.defaultEntry ?? "learn"}`);
      })
      .catch(() => {
        if (active) setError("暂时无法连接学习空间，请检查网络后重试。");
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

  return (
    <main className="route-loading" aria-live="polite">
      <span className="spinner route-loading__mark" aria-hidden="true" />
      正在进入 AIstudy
    </main>
  );
}
