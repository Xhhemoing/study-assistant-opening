"use client";

import Link from "next/link";
import type { summarizeDraftDiff } from "./document-editor-model";
import { ui } from "../opening/design/ui";

type Diff = ReturnType<typeof summarizeDraftDiff>;

/**
 * J1 / G2: conflict resolution. The local draft stays in storage until the
 * user picks one of: view diff, save as a new note, or confirmed discard.
 * No auto-merge (PM decision).
 */
export function DraftConflictPanel({
  reason,
  diff,
  busy,
  confirmingDiscard,
  savedAsNewHref,
  relationNote,
  onViewDiff,
  onSaveAsNew,
  onDiscard,
  onCancelDiscard,
}: {
  reason: "stale-base" | "legacy-draft" | "server-conflict";
  diff: Diff | null;
  busy: boolean;
  confirmingDiscard: boolean;
  savedAsNewHref: string | null;
  relationNote: string | null;
  onViewDiff: () => void;
  onSaveAsNew: () => void;
  onDiscard: () => void;
  onCancelDiscard: () => void;
}) {
  const why = reason === "legacy-draft"
    ? "这份本地草稿来自旧版本编辑器，无法确认它基于哪个服务器版本。"
    : reason === "stale-base"
      ? "本地草稿基于较早的服务器版本，期间笔记已被更新。"
      : "保存时服务器已有更新版本。";
  return <section role="alert" aria-label="保存冲突" data-draft-conflict={reason} className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
    <p className="font-medium">本地修改尚未保存，也不会被自动覆盖或删除。</p>
    <p className="mt-1 text-xs leading-5">{why}请选择处理方式：</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" className={ui.secondary} onClick={onViewDiff} disabled={busy}>查看差异</button>
      <button type="button" className={ui.secondary} onClick={onSaveAsNew} disabled={busy || Boolean(savedAsNewHref)}>另存为新笔记</button>
      {confirmingDiscard
        ? <><button type="button" className={ui.secondary} onClick={onDiscard} disabled={busy} data-confirm-discard="true">确认放弃本地修改并加载最新版本</button><button type="button" className={ui.quiet} onClick={onCancelDiscard} disabled={busy}>取消</button></>
        : <button type="button" className={ui.quiet} onClick={onDiscard} disabled={busy}>放弃本地修改…</button>}
    </div>
    {savedAsNewHref ? <p className="mt-2 text-xs" role="status">已另存为新笔记：<Link className="underline" href={savedAsNewHref}>打开副本</Link>{relationNote ? `（${relationNote}）` : ""}</p> : null}
    {diff ? <div className="mt-3 grid gap-2 sm:grid-cols-2" data-draft-diff="true">
      <div className="rounded border border-amber-200 bg-white p-2"><p className="text-xs text-zinc-500">本地草稿（基于 v{diff.local.baseRevisionNumber ?? "?"}）</p><p className="font-medium">{diff.local.title}</p><pre className="mt-1 whitespace-pre-wrap text-xs">{diff.local.text}</pre></div>
      <div className="rounded border border-amber-200 bg-white p-2"><p className="text-xs text-zinc-500">服务器最新（v{diff.server.revisionNumber ?? "?"}）</p><p className="font-medium">{diff.server.title}</p><pre className="mt-1 whitespace-pre-wrap text-xs">{diff.server.text}</pre></div>
    </div> : null}
  </section>;
}
