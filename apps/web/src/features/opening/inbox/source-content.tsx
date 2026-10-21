"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { acknowledgeStudyExposureHeaders } from "../assistant/study-exposure-ack";
import { studyConversationHref } from "../assistant/study-conversation-context";
import { z } from "zod";
import { ui } from "../design/ui";
import { parseOpeningResponse } from "../client/parse-response";
import { rememberSourceReaderPage, sourceReaderInitialPage } from "./source-reader-position";
import { SourceVersionDetails } from "./source-version-details";
const schema = z.object({ sourceId: z.string().uuid(), version: z.number().int().nonnegative(), currentVersion: z.number().int().nonnegative(),
  page: z.number().int().positive().nullable(), pages: z.array(z.number().int().positive().nullable()), pageKind: z.enum(["physical", "section"]),
  readablePages: z.number().int().nonnegative(), characters: z.number().int().nonnegative(), text: z.string().max(20000), truncated: z.boolean() });
type Content = z.infer<typeof schema>;
export async function loadSourceContent(sourceId: string, version: number, page?: number, fetcher: typeof fetch = fetch): Promise<Content> {
  const query = new URLSearchParams({ version: String(version) });
  if (page !== undefined) query.set("page", String(page));
  const response = await fetcher(`/api/opening/sources/${sourceId}/content?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`解析正文暂不可读取 (${response.status})`);
  const content = parseOpeningResponse(schema, await response.json().catch(() => null));
  if (content.sourceId !== sourceId || content.version !== version || (page !== undefined && content.page !== page)) {
    throw new Error("读到的材料内容或页码与这次打开的内容不一致，请重新读取。");
  }
  acknowledgeStudyExposureHeaders(response, fetcher);
  return content;
}
/** Page explanations need current, actually readable physical-page evidence. */
export function sourceContentExplanation(content: Content): { href: string; label: string } | null {
  if (content.version !== content.currentVersion || content.pageKind !== "physical" || content.page == null || !content.text.trim()) return null;
  return { href: studyConversationHref({ sourceId: content.sourceId, sourceVersion: content.version, page: content.page, purpose: "material_read", label: `材料第 ${content.page} 页` }), label: `解释第 ${content.page} 页` };
}
export function SourceContentBody({ content }: { content: Content }) {
  return <div className="space-y-3">
    <p className="text-xs text-text-2">{content.pageKind === "physical" ? "物理页" : "文本段"} {content.page ?? "未编号"} · {content.pages.length} 页/段 · {content.characters} 个提取字符</p>
    <SourceVersionDetails requestedVersion={content.version} currentVersion={content.currentVersion} />
    <p className="text-xs text-warn">提取文字可能有遗漏，请核对原件。</p>
    {content.text.trim() ? <pre data-study-reading-text="true" data-source-page={content.page ?? undefined} data-page-kind={content.pageKind} className="max-h-[65dvh] overflow-auto whitespace-pre-wrap break-words border-y border-line py-4 font-sans text-sm leading-7 text-text">{content.text}</pre>
      : <p className="py-4 text-sm text-warn">本页未提取到正文，不能作为文字依据；请核对原件。图片或扫描页在未配置 OCR 时无法提取文字。</p>}
    {content.truncated ? <p className="text-xs text-warn">本页显示内容已截断，请打开原件核对完整内容。</p> : null}
  </div>;
}
export function SourceContent({ sourceId, version, initialPage, onExplain }: { sourceId: string; version: number; initialPage?: number; onExplain?: (page: number) => void }) {
  const [content, setContent] = useState<Content | null>(null), [page, setPage] = useState<number | undefined>(() => sourceReaderInitialPage(sourceId, version, initialPage));
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => { setPage(sourceReaderInitialPage(sourceId, version, initialPage)); }, [sourceId, version, initialPage]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setContent(null);
    void loadSourceContent(sourceId, version, page).then(value => { if (active) { setContent(value); rememberSourceReaderPage(sourceId, version, value.page); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "读取失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sourceId, version, page, revision]);
  const index = content ? content.pages.indexOf(content.page) : -1;
  const explanation = content ? sourceContentExplanation(content) : null;
  return <section aria-label="解析正文" className="space-y-3 border-t border-line pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-text">解析正文</h3>
      <button type="button" className={ui.quiet} disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />重新读取</button></div>
    {loading ? <p role="status" className="text-xs text-text-3">正在读取正文…</p> : null}
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    {content ? <><div className="flex flex-wrap items-center gap-2">
      <button type="button" aria-label="上一页正文" className={ui.icon} disabled={index <= 0} onClick={() => setPage(content.pages[index - 1] ?? undefined)}><ChevronLeft size={14} aria-hidden="true" /></button>
      <select aria-label="正文页码" className={`${ui.input} max-w-40`} value={content.page ?? "unpaged"} onChange={event => setPage(event.target.value === "unpaged" ? undefined : Number(event.target.value))}>
        {content.pages.map(value => <option key={value ?? "unpaged"} value={value ?? "unpaged"}>{content.pageKind === "physical" ? "物理页" : "文本段"} {value ?? "未编号"}</option>)}
      </select>
      {explanation ? onExplain && content.page != null ? <button type="button" className={ui.primary} onClick={() => onExplain(content.page!)}><Sparkles size={14} aria-hidden="true" />{explanation.label}</button> : <Link className={ui.primary} href={explanation.href}><Sparkles size={14} aria-hidden="true" />{explanation.label}</Link> : null}
      <button type="button" aria-label="下一页正文" className={ui.icon} disabled={index >= content.pages.length - 1} onClick={() => setPage(content.pages[index + 1] ?? undefined)}><ChevronRight size={14} aria-hidden="true" /></button>
    </div><SourceContentBody content={content} /></> : null}
  </section>;
}
