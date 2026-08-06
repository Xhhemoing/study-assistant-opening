"use client";

import { useEffect, useState } from "react";

import { BlockMenu } from "./notebook-preview-block-menu";
import { NotebookDocument } from "./notebook-preview-document";
import {
  AiOverlay,
  MinimalHeader,
  PageActions,
  PageInfoOverlay,
  ShareOverlay,
} from "./notebook-preview-overlays";
import type { NotebookMode, OverlayName } from "./notebook-preview-types";

type PopoverName = "blocks" | "actions" | null;

export function NotebookPreview() {
  const [mode, setMode] = useState<NotebookMode>("edit");
  const [overlay, setOverlay] = useState<OverlayName>(null);
  const [popover, setPopover] = useState<PopoverName>(null);
  const [proposalApplied, setProposalApplied] = useState(false);

  useEffect(() => {
    function closeSurfaces(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOverlay(null);
        setPopover(null);
      }
    }

    document.addEventListener("keydown", closeSurfaces);
    return () => document.removeEventListener("keydown", closeSurfaces);
  }, []);

  function openBlocks() {
    setPopover("blocks");
    setOverlay(null);
  }

  function selectPageAction(action: "ai" | "page-info" | "learn") {
    setPopover(null);
    if (action === "learn") {
      setMode("learn");
      return;
    }
    setOverlay(action);
  }

  return (
    <main className="notebook-preview scheme-dark min-h-screen overflow-x-hidden bg-[#191919] text-stone-100">
      <a className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 rounded bg-white px-3 py-2 text-sm font-semibold text-stone-900 shadow" href="#notebook-page">跳到页面内容</a>
      <MinimalHeader
        menuOpen={popover === "actions"}
        onMenu={() => {
          setPopover((current) => current === "actions" ? null : "actions");
          setOverlay(null);
        }}
        onShare={() => {
          setOverlay((current) => current === "share" ? null : "share");
          setPopover(null);
        }}
      />

      <div className="relative" id="notebook-page">
        {popover === "actions" ? <PageActions onSelect={selectPageAction} /> : null}
        {overlay === "page-info" ? <PageInfoOverlay onClose={() => setOverlay(null)} /> : null}
        {overlay === "ai" ? <AiOverlay applied={proposalApplied} onApply={() => setProposalApplied(true)} onClose={() => setOverlay(null)} /> : null}
        {overlay === "share" ? <ShareOverlay onClose={() => setOverlay(null)} /> : null}

        <div className="relative">
          <NotebookDocument
            mode={mode}
            onExitLearn={() => setMode("edit")}
            onOpenBlocks={openBlocks}
            proposalApplied={proposalApplied}
          />
          {popover === "blocks" ? <div className="absolute left-6 top-[30rem] sm:left-[max(2rem,calc((100vw-62rem)/2))]"><BlockMenu onClose={() => setPopover(null)} /></div> : null}
        </div>
      </div>
    </main>
  );
}
