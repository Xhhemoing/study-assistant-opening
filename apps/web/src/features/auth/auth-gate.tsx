"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { loginHrefForReturn } from "./auth-form-model";
import { clearSessionExpiry, installSessionFetch, subscribeToSessionExpiry } from "./session-expiry";

type SessionIdentity = { id: string; workspaceId: string };

async function readSessionIdentity(response: Response): Promise<SessionIdentity | null> {
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || !("user" in body) || !body.user || typeof body.user !== "object") return null;
  const user = body.user;
  return "id" in user && typeof user.id === "string" && user.id.trim() && "workspaceId" in user && typeof user.workspaceId === "string" && user.workspaceId.trim()
    ? { id: user.id, workspaceId: user.workspaceId } : null;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [checkingSession, setCheckingSession] = useState(false);
  const [expiryError, setExpiryError] = useState("");
  const initialIdentity = useRef<SessionIdentity | null>(null);
  const checkingSessionRef = useRef(false);
  const loginLink = useRef<HTMLAnchorElement | null>(null);
  const recoveryDialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToSessionExpiry(() => {
      setExpired(true);
      setExpiryError("");
    });
    const restoreFetch = installSessionFetch();
    return () => { restoreFetch(); unsubscribe(); };
  }, []);

  useEffect(() => {
    const dialog = recoveryDialog.current;
    if (!dialog) return;
    if (expired) {
      // Enter the top layer above any lesson/material modal already open.
      if (!dialog.open) dialog.showModal();
      loginLink.current?.focus();
    } else if (dialog.open) dialog.close();
  }, [expired]);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (response.ok) {
          const identity = await readSessionIdentity(response);
          if (!active) return;
          if (!identity) { setError("暂时无法验证登录账户，请稍后重试。"); return; }
          initialIdentity.current = identity;
          clearSessionExpiry();
          setReady(true);
        }
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

  async function recheckSession() {
    if (checkingSessionRef.current) return;
    checkingSessionRef.current = true;
    setCheckingSession(true);
    setExpiryError("");
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (response.ok) {
        const identity = await readSessionIdentity(response);
        if (!identity || identity.id !== initialIdentity.current?.id || identity.workspaceId !== initialIdentity.current?.workspaceId) {
          setExpiryError("请切回原账户和学习空间。当前草稿暂未提交。");
          return;
        }
        clearSessionExpiry(); setExpired(false);
      }
      else setExpiryError(response.status === 401 ? "请先在新标签页完成登录。" : "暂时无法验证登录，请重试。");
    } catch {
      setExpiryError("无法连接到服务，请检查网络后重试。");
    } finally { checkingSessionRef.current = false; setCheckingSession(false); }
  }

  return <>
    <dialog ref={recoveryDialog} aria-label="登录已过期" onCancel={event => event.preventDefault()} className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950 shadow-xl backdrop:bg-black/30">
    {expired ? <div className="flex flex-wrap items-center gap-3">
      <p className="basis-full">登录已过期，当前学习已暂停。草稿仍保留，请在新标签页登录原账户，再回到此页继续。</p>
      <a ref={loginLink} className="inline-flex min-h-11 items-center rounded-md bg-zinc-900 px-3 font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2" href={loginHrefForReturn(`${window.location.pathname}${window.location.search}${window.location.hash}`)} target="_blank" rel="noopener noreferrer">重新登录（新标签页）</a>
      <button type="button" className="inline-flex min-h-11 items-center rounded-md border border-amber-800 px-3 font-medium disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2" disabled={checkingSession} onClick={() => void recheckSession()}>{checkingSession ? "正在验证登录…" : "已登录，继续"}</button>
      {expiryError ? <p role="alert" className="basis-full">{expiryError}</p> : null}
    </div> : null}
    </dialog>
    <div className="contents" inert={expired}>{children}</div>
  </>;
}
