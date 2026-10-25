"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { SourceRecord } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { ui } from "../design/ui";
import { captureReaderReturnPoint, type ReaderReturnPoint } from "./reader-return-point";
import { SourceReader, SourceReaderFrame } from "./source-reader";
import { parseSourceViewerSearchParams, type SourceViewerTarget } from "./source-viewer";
import { userFacingMessage } from "../../../lib/user-facing-error";

type CitationClick = {
  href: string;
  origin: string;
  button: number;
  defaultPrevented?: boolean;
  modified?: boolean;
  target?: string | null;
  download?: boolean;
  withinReader?: boolean;
  inLibrary?: boolean;
};

/** Only intercept the application's pinned material links; ordinary navigation remains native. */
export function citationReaderTarget(click: CitationClick): SourceViewerTarget | null {
  if (click.button !== 0 || click.defaultPrevented || click.modified || click.download || click.withinReader || click.inLibrary) return null;
  if (click.target && click.target !== "_self") return null;
  let url: URL;
  try { url = new URL(click.href, click.origin); } catch { return null; }
  if (url.origin !== click.origin || url.pathname !== "/opening/library" || url.searchParams.get("tab") !== "materials") return null;
  return parseSourceViewerSearchParams(Object.fromEntries(url.searchParams));
}

export async function loadCitationReaderRecord(api: Pick<OpeningApi, "listSources">, target: SourceViewerTarget): Promise<SourceRecord> {
  const record = (await api.listSources()).find(source => source.id === target.sourceId);
  if (!record) throw new Error("这份材料已移除或暂时无法访问，原学习内容已保留。");
  if (record.uploadState !== "uploaded") throw new Error("这份材料尚未上传完成，请到资料库处理；原学习内容已保留。");
  if (target.version > record.version) throw new Error("引用时的材料内容暂时无法读取，请刷新资料库后重试。");
  return record;
}

/** Read citations in place so closing the reader never remounts the current learning unit. */
export function CitationReaderHost({ api: supplied }: { api?: OpeningApi }) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const pathname = usePathname();
  const [request, setRequest] = useState<{ target: SourceViewerTarget; href: string; returnPoint: ReaderReturnPoint; courseId?: string; questionProtected: boolean } | null>(null);
  const [record, setRecord] = useState<SourceRecord | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    // The shell persists across routes; a citation belongs to its originating learning view.
    sequence.current++;
    setRequest(null); setRecord(null); setError("");
  }, [pathname]);
  useEffect(() => {
    function open(event: MouseEvent) {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const target = citationReaderTarget({
        href: anchor.href, origin: window.location.origin, button: event.button,
        defaultPrevented: event.defaultPrevented, modified: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        target: anchor.getAttribute("target"), download: anchor.hasAttribute("download"),
        withinReader: !!anchor.closest("[data-material-reader]"), inLibrary: window.location.pathname === "/opening/library",
      });
      if (!target) return;
      event.preventDefault();
      setRecord(null); setError("");
      setRequest({ target, href: anchor.href, returnPoint: captureReaderReturnPoint(anchor),
        courseId: /^\/opening\/courses\/([^/]+)/.exec(window.location.pathname)?.[1],
        questionProtected: Boolean(anchor.closest('[data-study-question="true"]')) });
    }
    document.addEventListener("click", open);
    return () => { document.removeEventListener("click", open); };
  }, []);
  useEffect(() => {
    if (!request) return;
    const current = ++sequence.current;
    setError("");
    void loadCitationReaderRecord(api, request.target).then(value => {
      if (current === sequence.current) setRecord(value);
    }).catch(reason => {
      if (current === sequence.current) setError(userFacingMessage(reason, "材料暂时无法读取。"));
    });
    return () => { sequence.current++; };
  }, [api, request, revision]);
  if (!request) return null;
  const close = () => { sequence.current++; setRequest(null); setRecord(null); setError(""); };
  return record ? <SourceReader record={record} requestedVersion={request.target.version} page={request.target.page} startMs={request.target.startMs} slideLabel={request.target.slideLabel}
    returnPoint={request.returnPoint} courseId={request.courseId} originalConversationId={request.target.conversationId} questionProtected={request.questionProtected} onClose={close} onRetry={async () => {
      const current = sequence.current;
      await api.retryParse(record.id);
      const value = await loadCitationReaderRecord(api, request.target);
      if (current === sequence.current) setRecord(value);
    }} />
    : <SourceReaderFrame title="查看引用材料" onClose={close} returnPoint={request.returnPoint}>
      {error ? <div className="space-y-3"><p role="alert" className="text-sm text-danger">{error}</p>
        <button type="button" className={ui.secondary} onClick={() => setRevision(value => value + 1)}>重新读取</button>
        <a href={request.href} className={ui.quiet}>在资料库中打开</a></div>
        : <p role="status" className="text-sm text-text-2">正在读取引用材料…</p>}
    </SourceReaderFrame>;
}
