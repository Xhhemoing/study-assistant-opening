"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { materialAnalysisHref } from "../library/material-analysis-link";
import { z } from "zod";
import { ui } from "../design/ui";
const schema = z.object({ sourceId: z.string().uuid(), version: z.number().int().nonnegative(), currentVersion: z.number().int().nonnegative(),
  page: z.number().int().positive().nullable(), pages: z.array(z.number().int().positive().nullable()), pageKind: z.enum(["physical", "section"]),
  readablePages: z.number().int().nonnegative(), characters: z.number().int().nonnegative(), text: z.string().max(20000), truncated: z.boolean() });
type Content = z.infer<typeof schema>;
export async function loadSourceContent(sourceId: string, version: number, page?: number, fetcher: typeof fetch = fetch): Promise<Content> {
  const query = new URLSearchParams({ version: String(version) });
  if (page !== undefined) query.set("page", String(page));
  const response = await fetcher(`/api/opening/sources/${sourceId}/content?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`解析正文暂不可读取 (${response.status})`);
  return schema.parse(await response.json());
}
export function SourceContentBody({ content }: { content: Content }) {
  return <div className="space-y-3">
    <p className="text-xs text-zinc-600">v{content.version} · {content.pageKind === "physical" ? "物理页" : "文本段"} {content.page ?? "未编号"} · {content.pages.length} 页/段 · {content.characters} 个提取字符</p>
    <p className="text-xs text-amber-800">提取文字不代表完整原件；图片、图表和 OCR 公式可能存在遗漏，请与原件核对。</p>
    {content.text.trim() ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-y border-zinc-200 py-4 font-sans text-sm leading-7 text-zinc-800">{content.text}</pre>
      : <p role="status" className="py-4 text-sm text-amber-800">本页未提取到正文，不能作为文字依据；请核对原件，图片或扫描页需要 OCR。</p>}
    {content.truncated ? <p role="status" className="text-xs text-amber-800">本页显示内容已截断，请打开原件核对完整内容。</p> : null}
  </div>;
}
export function SourceContent({ sourceId, version, initialPage }: { sourceId: string; version: number; initialPage?: number }) {
  const [content, setContent] = useState<Content | null>(null), [page, setPage] = useState<number | undefined>(initialPage);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => { setPage(initialPage); }, [sourceId, version, initialPage]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setContent(null);
    void loadSourceContent(sourceId, version, page).then(value => { if (active) setContent(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "读取失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sourceId, version, page, revision]);
  const index = content ? content.pages.indexOf(content.page) : -1;
  return <section aria-label="解析正文" className="space-y-3 border-t border-zinc-200 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-zinc-900">解析正文</h3>
      <button type="button" className={ui.quiet} disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />重新读取</button></div>
    {loading ? <p role="status" className="text-xs text-zinc-500">正在读取正文…</p> : null}
    {error ? <p role="alert" className="text-xs text-red-700">{error}</p> : null}
    {content ? <><div className="flex flex-wrap items-center gap-2">
      <button type="button" aria-label="上一页正文" className={ui.icon} disabled={index <= 0} onClick={() => setPage(content.pages[index - 1] ?? undefined)}><ChevronLeft size={14} aria-hidden="true" /></button>
      <select aria-label="正文页码" className={`${ui.input} max-w-40`} value={content.page ?? "unpaged"} onChange={event => setPage(event.target.value === "unpaged" ? undefined : Number(event.target.value))}>
        {content.pages.map(value => <option key={value ?? "unpaged"} value={value ?? "unpaged"}>{content.pageKind === "physical" ? "物理页" : "文本段"} {value ?? "未编号"}</option>)}
      </select>
      {content.version === content.currentVersion && content.pageKind === "physical" && content.page != null ? <Link className={ui.primary} href={materialAnalysisHref(sourceId, content.page)}><Sparkles size={14} aria-hidden="true" />AI 分析本页</Link> : null}
      <button type="button" aria-label="下一页正文" className={ui.icon} disabled={index >= content.pages.length - 1} onClick={() => setPage(content.pages[index + 1] ?? undefined)}><ChevronRight size={14} aria-hidden="true" /></button>
    </div><SourceContentBody content={content} /></> : null}
  </section>;
}
