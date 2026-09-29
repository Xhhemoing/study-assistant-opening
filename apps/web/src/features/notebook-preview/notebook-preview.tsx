"use client";

import { useState } from "react";

import { Inspector } from "../opening/design/inspector";
import { BlockMenu } from "./notebook-preview-block-menu";
import { NotebookDocument } from "./notebook-preview-document";
import { AiOverlay, MinimalHeader, PageActions, PageInfoOverlay, ShareOverlay } from "./notebook-preview-overlays";
import type { NotebookMode, OverlayName } from "./notebook-preview-types";

export function NotebookPreview() {
  const [mode, setMode] = useState<NotebookMode>("edit");
  const [overlay, setOverlay] = useState<OverlayName | "blocks">(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [proposalApplied, setProposalApplied] = useState(false);
  return <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-white text-zinc-900">
    <a className="sr-only rounded bg-white px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50" href="#notebook-page">跳到页面内容</a>
    <MinimalHeader menuOpen={actionsOpen} onMenu={() => setActionsOpen(value => !value)} onShare={() => setOverlay("share")} />
    {actionsOpen ? <PageActions onSelect={action => { setActionsOpen(false); if (action === "learn") setMode("learn"); else setOverlay(action); }} /> : null}
    <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs leading-5 text-zinc-500">交互预览 · 示例内容 · 不调用 AI、不保存笔记或学习记录 · 刷新后重置</div>
    <div className="flex min-h-0 flex-1"><div className="min-w-0 flex-1 overflow-y-auto" id="notebook-page"><NotebookDocument mode={mode} onExitLearn={() => setMode("edit")} onOpenBlocks={() => setOverlay("blocks")} proposalApplied={proposalApplied} /></div>
      <Inspector open={overlay !== null} onClose={() => setOverlay(null)} title={overlay === "blocks" ? "内容块示例" : overlay === "ai" ? "学习版示例" : overlay === "share" ? "分享状态" : "示例页面信息"} id="notebook-preview-context">
        {overlay === "blocks" ? <BlockMenu /> : null}
        {overlay === "page-info" ? <PageInfoOverlay /> : null}
        {overlay === "ai" ? <AiOverlay applied={proposalApplied} onApply={() => setProposalApplied(value => !value)} /> : null}
        {overlay === "share" ? <ShareOverlay /> : null}
      </Inspector>
    </div>
  </main>;
}
