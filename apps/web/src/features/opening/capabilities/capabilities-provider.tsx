"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  acceptCapabilitiesResponse,
  CLOSED_CAPABILITIES,
  type OpeningCapabilities,
} from "@aistudy/config/public";

/** Fail closed: everything off until the server says otherwise. */
type CapabilityStatus = { status: "loading" | "ready" | "error" | "incompatible"; retry: () => void };
const CapabilityStatusContext = createContext<CapabilityStatus>({ status: "ready", retry: () => {} });

export function OpeningCapabilityNotice() {
  const { status, retry } = useContext(CapabilityStatusContext);
  if (status === "ready") return null;
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 px-5 py-2 text-xs leading-5 text-zinc-600" role="status">
    <span>{status === "loading" ? "正在确认可用的学习功能…" : status === "incompatible" ? "页面版本与服务不一致，部分功能暂不可用。请刷新页面后重试。" : "学习功能状态读取失败；这不表示功能已关闭。"}</span>
    {status !== "loading" ? <button type="button" className="min-h-9 px-2 text-emerald-800 underline focus-visible:ring-2 focus-visible:ring-emerald-700" onClick={status === "incompatible" ? () => window.location.reload() : retry}>{status === "incompatible" ? "刷新页面" : "重新读取"}</button> : null}
  </div>;
}

export const OpeningCapabilitiesContext = createContext<OpeningCapabilities>(CLOSED_CAPABILITIES);

export function useOpeningCapabilities(): OpeningCapabilities {
  return useContext(OpeningCapabilitiesContext);
}

/** Digest inlined at next build via next.config `env`; compared to the server's runtime digest. */
const COMPILED_BUILD_CONFIG_DIGEST = process.env.AISTUDY_BUILD_CONFIG_DIGEST;

export function OpeningCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CapabilityStatus["status"]>("loading");
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);
  const [capabilities, setCapabilities] = useState<OpeningCapabilities>(CLOSED_CAPABILITIES);
  useEffect(() => {
    let alive = true;
    setStatus("loading");
    fetch("/api/opening/capabilities", { cache: "no-store", credentials: "same-origin" })
      .then((response) => { if (!response.ok) throw new Error("capabilities unavailable"); return response.json(); })
      .then((raw: unknown) => {
        if (!alive) return;
        const accepted = acceptCapabilitiesResponse(raw, COMPILED_BUILD_CONFIG_DIGEST);
        if (!accepted.compatible) console.warn(`opening capabilities disabled: ${accepted.reason}`);
        setCapabilities(accepted.capabilities);
        setStatus(accepted.compatible ? "ready" : "incompatible");
      })
      .catch(() => {
        if (alive) { setCapabilities(CLOSED_CAPABILITIES); setStatus("error"); }
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  return <CapabilityStatusContext.Provider value={{ status, retry }}><OpeningCapabilitiesContext.Provider value={capabilities}>{children}</OpeningCapabilitiesContext.Provider></CapabilityStatusContext.Provider>;
}
