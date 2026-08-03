"use client";

import { Plus, RefreshCw, Tag, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { StudyDataProvider } from "../../lib/data/types";

export function PropertiesPanel({ documentId, provider }: { documentId: string; provider: StudyDataProvider | null }) {
  const [tags, setTags] = useState<string[] | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    setTags(null);
    setError("");
    provider.getDocumentTags(documentId).then((nextTags) => {
      if (active) setTags(nextTags);
    }).catch(() => {
      if (active) setError("标签暂时无法读取。");
    });
    return () => { active = false; };
  }, [documentId, provider, reloadToken]);

  async function submitTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tag = input.trim();
    if (!provider || !tag) return;
    try {
      const nextTags = await provider.setDocumentTags(documentId, [...(tags ?? []), tag]);
      setTags(nextTags);
      setInput("");
      setError("");
    } catch {
      setError("标签保存失败，请稍后重试。");
    }
  }

  async function removeTag(tag: string) {
    if (!provider) return;
    try {
      setTags(await provider.setDocumentTags(documentId, (tags ?? []).filter((item) => item !== tag)));
    } catch {
      setError("标签保存失败，请稍后重试。");
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="document-properties-title">
      <div className="mb-3 flex items-center gap-2"><Tag aria-hidden="true" className="text-primary" size={16} /><h2 className="text-sm font-semibold text-text" id="document-properties-title">属性</h2></div>
      <div className="mb-3 flex flex-wrap gap-2">
        {tags?.map((tag) => <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs text-text" key={tag}>{tag}<button className="text-text-dim hover:text-text" type="button" onClick={() => removeTag(tag)} aria-label={`移除标签 ${tag}`} title={`移除标签 ${tag}`}><X aria-hidden="true" size={13} /></button></span>)}
        {tags === null ? <span className="text-xs text-text-dim">正在读取标签...</span> : null}
        {tags?.length === 0 ? <span className="text-xs text-text-dim">还没有标签</span> : null}
      </div>
      <form className="flex gap-2" onSubmit={submitTag}>
        <label className="min-w-0 flex-1"><span className="sr-only">新增标签</span><input className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-text outline-none placeholder:text-text-dim focus:border-primary" value={input} onChange={(event) => setInput(event.target.value)} placeholder="输入标签" /></label>
        <button className="inline-grid size-10 shrink-0 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 hover:text-text disabled:opacity-40" type="submit" disabled={!input.trim() || !provider} aria-label="添加标签" title="添加标签"><Plus aria-hidden="true" size={16} /></button>
      </form>
      {error ? <div className="mt-2 flex items-center gap-2" role="alert"><p className="text-xs text-danger">{error}</p><button aria-label="重试读取标签" className="inline-grid size-8 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setReloadToken((value) => value + 1)} title="重试读取标签" type="button"><RefreshCw aria-hidden="true" size={14} /></button></div> : null}
    </section>
  );
}
