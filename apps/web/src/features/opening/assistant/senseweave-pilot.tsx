"use client";

import { useEffect, useRef, useState } from "react";

type SenseWeaveView = {
  render(input: { id: string; content: string }): void;
  unmount(): void;
};

type SenseWeaveBrowserModule = {
  mountSenseWeave(
    host: HTMLElement,
    options: {
      theme?: "light" | "dark";
      capabilities?: { components?: string[]; maxInteractiveBlocks?: number };
      onError?: (error: unknown) => void;
    },
  ): Promise<SenseWeaveView>;
};

/**
 * The pilot is intentionally opt-in. The original LearningProse node remains
 * the source of truth for citations and Markdown selection mapping.
 */
export const senseWeavePilotEnabled = process.env.NEXT_PUBLIC_SENSEWEAVE_PILOT === "1";

export function safeSenseWeaveMessageId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "opening-message";
}

export function shouldShowSenseWeavePilot(content: string): boolean {
  return senseWeavePilotEnabled && content.trim().length > 0;
}

async function loadSenseWeaveBrowser(): Promise<SenseWeaveBrowserModule> {
  // The rc.1 package is intentionally not bundled into the default web build.
  // Install the local TGZ and let the host bundler resolve this bare specifier
  // when NEXT_PUBLIC_SENSEWEAVE_PILOT=1.
  return import(/* webpackIgnore: true */ "senseweave-runtime/browser") as Promise<SenseWeaveBrowserModule>;
}

export function SenseWeavePilot({ messageId, content }: { messageId: string; content: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<SenseWeaveView | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "fallback">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !shouldShowSenseWeavePilot(content) || !hostRef.current) return;
    let disposed = false;
    setStatus("loading");
    setError(null);
    void loadSenseWeaveBrowser()
      .then(({ mountSenseWeave }) => mountSenseWeave(hostRef.current!, {
        theme: "light",
        capabilities: { components: ["prose", "steps", "compare", "calc"], maxInteractiveBlocks: 3 },
        onError: (reason) => {
          if (!disposed) setError(reason instanceof Error ? reason.message : "呈现观察失败");
        },
      }))
      .then((view) => {
        if (disposed) {
          view.unmount();
          return;
        }
        viewRef.current = view;
        view.render({ id: safeSenseWeaveMessageId(messageId), content });
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setStatus("fallback");
          setError(reason instanceof Error ? reason.message : "SenseWeave 未安装或无法加载");
        }
      });
    return () => {
      disposed = true;
      viewRef.current?.unmount();
      viewRef.current = null;
    };
  }, [content, messageId, open]);

  if (!shouldShowSenseWeavePilot(content)) return null;
  return <section className="mt-3 rounded-xl border border-dashed border-sky-300 bg-sky-50/40 p-3" aria-label="SenseWeave 试点">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-xs font-semibold text-sky-900">SenseWeave 试点</p>
        <p className="text-[11px] leading-5 text-sky-800/80">仅呈现同一份原始回答，不触发模型请求；正文、引用和笔记选区仍由原界面负责。</p>
      </div>
      <button type="button" onClick={() => setOpen((value) => !value)} className="min-h-8 rounded-lg border border-sky-300 bg-white px-2.5 text-xs font-medium text-sky-900 hover:bg-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600/50">
        {open ? "收起试点" : "打开结构化呈现"}
      </button>
    </div>
    {open ? <div className="mt-3">
      <div ref={hostRef} data-senseweave-host={messageId} className="min-h-8 rounded-lg bg-white p-3" />
      {status === "loading" ? <p className="mt-2 text-xs text-sky-800">正在加载本地 SenseWeave 包…</p> : null}
      {status === "fallback" ? <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-white p-3 text-sm leading-6 text-zinc-800">{content}</pre> : null}
      {error ? <p className="mt-2 text-xs text-amber-800" role="status">试点已降级为原文：{error}</p> : null}
      {status === "ready" ? <p className="mt-2 text-[11px] text-sky-800/80">可交互组件仅影响此预览；不会写入学习状态。</p> : null}
    </div> : null}
  </section>;
}
