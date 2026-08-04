"use client";

import { Plus, RefreshCw, Tag, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createDocumentTagsApi } from "./document-tags-api";

export function PropertiesPanel({ documentId }: { documentId: string }) {
  const api = useMemo(() => createDocumentTagsApi(), []);
  const [tags, setTags] = useState<string[] | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setTags(null);
    setError("");
    api.get(documentId).then((nextTags) => {
      if (active) setTags(nextTags);
    }).catch(() => {
      if (active) setError("标签暂时无法读取。");
    });
    return () => { active = false; };
  }, [api, documentId, reloadToken]);

  async function persist(nextTags: string[]) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      setTags(await api.set(documentId, nextTags));
      setInput("");
    } catch {
      setError("标签保存失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  function submitTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tag = input.trim();
    if (!tag) return;
    void persist([...(tags ?? []), tag]);
  }

  function removeTag(tag: string) {
    void persist((tags ?? []).filter((item) => item !== tag));
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="document-properties-title">
      <div className="mb-3 flex items-center gap-2"><Tag aria-hidden="true" className="text-primary" size={16} /><h2 className="text-sm font-semibold text-text" id="document-properties-title">属性</h2></div>
      <div className="mb-3 flex flex-wrap gap-2">
        {tags?.map((tag) => <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs text-text" key={tag}>{tag}<button className="text-text-dim hover:text-text disabled:opacity-40" disabled={pending} type="button" onClick={() => removeTag(tag)} aria-label={`移除标签 ${tag}`} title={`移除标签 ${tag}`}><X aria-hidden="true" size={13} /></button></span>)}
        {tags === null && !error ? <span className="text-xs text-text-dim" role="status">正在读取标签...</span> : null}
        {tags?.length === 0 ? <span className="text-xs text-text-dim">还没有标签</span> : null}
      </div>
      <form className="flex gap-2" onSubmit={submitTag}>
        <label className="min-w-0 flex-1"><span className="sr-only">新增标签</span><input className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-text outline-none placeholder:text-text-dim focus:border-primary disabled:opacity-50" disabled={pending} value={input} onChange={(event) => setInput(event.target.value)} placeholder="输入标签" /></label>
        <button className="inline-grid size-10 shrink-0 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 hover:text-text disabled:opacity-40" type="submit" disabled={!input.trim() || pending || tags === null} aria-label="添加标签" title="添加标签"><Plus aria-hidden="true" size={16} /></button>
      </form>
      {error ? <div className="mt-2 flex items-center gap-2" role="alert"><p className="text-xs text-danger">{error}</p><button aria-label="重试读取标签" className="inline-grid size-8 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={reload} title="重试读取标签" type="button"><RefreshCw aria-hidden="true" size={14} /></button></div> : null}
    </section>
  );
}
