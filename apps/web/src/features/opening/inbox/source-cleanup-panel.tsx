"use client";

import { useEffect, useState } from "react";
import type { SourceDeletion } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { createSourceActionsClient } from "./source-actions-client";
import { sourceActionNotice } from "./source-actions-panel";

const client = createSourceActionsClient();
export function SourceCleanupPanel({ revision }: { revision: unknown }) {
  const [pending, setPending] = useState<SourceDeletion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void client.deletions().then(rows => { if (live) { setPending(rows); setError(false); } }, () => { if (live) setError(true); });
    return () => { live = false; };
  }, [revision, attempt]);
  async function retry(id: string) {
    setBusy(id); setNotice(null);
    try {
      const result = await client.act(id, { action: "retry_cleanup" });
      setNotice(sourceActionNotice(result));
      setPending(await client.deletions()); setError(false);
    } catch { setError(true); }
    finally { setBusy(null); }
  }
  if (!pending.length && !notice && !error) return null;
  return <section className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3" aria-label="材料清理状态">
    <h3 className="text-sm font-medium text-zinc-900">材料清理状态</h3>
    {pending.map(row => <div key={row.sourceId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p>材料 {row.sourceId.slice(0, 8)} 已移除；{row.cleanupPending} 个已知对象待清理。{row.retryAfter ? `请在 ${new Date(row.retryAfter).toLocaleString()} 后复查。` : ""}</p>
      <button type="button" className={ui.secondary} disabled={busy !== null} onClick={() => void retry(row.sourceId)}>{busy === row.sourceId ? "处理中…" : "重试清理"}</button>
    </div>)}
    {notice ? <p role="status" className="text-sm text-zinc-700">{notice}</p> : null}
    {error ? <div className="space-y-2"><p role="alert" className="text-sm text-amber-900">清理状态暂时无法读取或更新，请重试。</p><button type="button" className={ui.quiet} onClick={() => setAttempt(value => value + 1)}>刷新清理状态</button></div> : null}
  </section>;
}
