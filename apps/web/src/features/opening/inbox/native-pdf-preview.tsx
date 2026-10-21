"use client";
import { useState } from "react";

/** Chromium's supported open parameters request page width and hide its thumbnail pane. */
export function fitPdfHref(href: string): string {
  const [path, fragment] = href.split("#");
  const params = new URLSearchParams(fragment);
  params.set("view", "FitH"); params.set("navpanes", "0");
  return `${path}#${params}`;
}

export function NativePdfPreview({ href, name, fillHeight = false, toolsOpen = false }: { href: string; name: string; fillHeight?: boolean; toolsOpen?: boolean }) {
  const [fitVisited, setFitVisited] = useState(toolsOpen);
  const [fitRevision, setFitRevision] = useState(0);
  if (toolsOpen && !fitVisited) setFitVisited(true);
  const frameClass = fillHeight ? "h-full min-h-0 w-full border-0 bg-bg" : "h-[calc(100dvh-15rem)] min-h-80 w-full border border-line bg-bg";
  return <div className="flex min-h-0 flex-1 flex-col gap-1">
    {toolsOpen ? <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs leading-5 text-text-3"><span>侧栏为独立适宽视图，两处滚动页不自动同步。</span><button type="button" className="min-h-8 px-2 text-accent underline focus-visible:ring-2 focus-visible:ring-emerald-700" onClick={() => setFitRevision(value => value + 1)}>恢复适宽</button></div> : null}
    <div hidden={toolsOpen} className={toolsOpen ? "hidden" : "min-h-0 flex-1"}><iframe title={`${name} 预览`} src={fitPdfHref(href)} className={frameClass} /></div>
    {fitVisited ? <div hidden={!toolsOpen} className={!toolsOpen ? "hidden" : "min-h-0 flex-1"}><iframe key={`${href}:${fitRevision}`} title={`${name} 侧栏适宽预览`} src={fitPdfHref(href)} className={frameClass} /></div> : null}
  </div>;
}
