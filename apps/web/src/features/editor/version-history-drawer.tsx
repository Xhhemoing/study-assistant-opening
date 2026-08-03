"use client";

import { History, RotateCcw } from "lucide-react";
import { Drawer } from "@aistudy/ui";
import { useEffect, useMemo, useState } from "react";
import {
  type EditorApi,
  type EditorRevision,
} from "./editor-api";
import { sortRevisions } from "./version-history";

type Props = {
  documentId: string;
  open: boolean;
  onClose: () => void;
  onRestore: (revision: EditorRevision) => Promise<void>;
  api: EditorApi;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockPreview(block: unknown): string {
  if (!isRecord(block)) return "空白块";
  const rawContent = block.content;
  const content = isRecord(rawContent) && "blockNoteContent" in rawContent
    ? rawContent.blockNoteContent
    : rawContent;
  if (typeof content === "string") return content || "空白块";
  if (Array.isArray(content)) {
    const text = content.flatMap((item) => {
      if (!isRecord(item)) return [];
      return typeof item.text === "string" ? [item.text] : [];
    }).join("");
    return text || "空白块";
  }
  return "结构化内容";
}

export function VersionHistoryDrawer({
  documentId,
  open,
  onClose,
  onRestore,
  api,
}: Props) {
  const [revisions, setRevisions] = useState<EditorRevision[] | null>(null);
  const [selected, setSelected] = useState<EditorRevision | null>(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const orderedRevisions = useMemo(
    () => (revisions ? sortRevisions(revisions) : []),
    [revisions],
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    setRevisions(null);
    setSelected(null);
    api.fetchRevisions(documentId)
      .then((nextRevisions) => {
        if (!active) return;
        const ordered = sortRevisions(nextRevisions);
        setRevisions(ordered);
        setSelected(ordered[0] ?? null);
      })
      .catch(() => {
        if (active) setError("暂时无法读取版本历史，请稍后重试。");
      });
    return () => { active = false; };
  }, [api, documentId, open]);

  async function restoreSelected() {
    if (!selected || restoring) return;
    setRestoring(true);
    setError("");
    try {
      await onRestore(selected);
      onClose();
    } catch {
      setError("恢复版本失败，请稍后重试。");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="版本历史">
      <div className="grid gap-5">
        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
        {revisions === null && !error ? <p className="text-sm text-text-dim" role="status">正在读取版本...</p> : null}
        {revisions?.length === 0 ? <p className="text-sm text-text-dim">还没有可用版本。</p> : null}
        {orderedRevisions.length > 0 ? (
          <div className="grid gap-2" aria-label="版本列表">
            {orderedRevisions.map((revision) => (
              <button
                key={revision.revisionNumber}
                className={`grid gap-1 rounded-md border px-3 py-2 text-left ${selected?.revisionNumber === revision.revisionNumber ? "border-primary bg-primary/10" : "border-line hover:bg-surface-2"}`}
                type="button"
                aria-pressed={selected?.revisionNumber === revision.revisionNumber}
                onClick={() => setSelected(revision)}
              >
                <span className="flex items-center justify-between text-sm font-semibold text-text"><span>v{revision.revisionNumber}</span><span className="text-xs font-normal text-text-dim">{revision.reason ?? "编辑"}</span></span>
                <span className="truncate text-xs text-text-dim">{revision.title}</span>
              </button>
            ))}
          </div>
        ) : null}
        {selected ? (
          <section className="grid gap-3 border-t border-line pt-4" aria-label="版本预览">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">预览 v{selected.revisionNumber}</p>
              <h3 className="mt-1 text-lg font-semibold text-text">{selected.title}</h3>
              <p className="mt-1 text-xs text-text-dim">{selected.blocks.length} 个内容块</p>
            </div>
            <div className="grid gap-2">
              {selected.blocks.slice(0, 4).map((block, index) => <p className="truncate rounded-md bg-ink px-3 py-2 text-sm text-text-dim" key={isRecord(block) && typeof block.id === "string" ? block.id : index}>{blockPreview(block)}</p>)}
            </div>
            <button className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-ink hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-50" type="button" onClick={restoreSelected} disabled={restoring}><RotateCcw aria-hidden="true" size={16} />{restoring ? "正在恢复..." : `恢复此版本`}</button>
          </section>
        ) : null}
        <p className="flex items-center gap-2 text-xs text-text-dim"><History aria-hidden="true" size={14} />恢复会创建新的版本，历史记录不会被覆盖。</p>
      </div>
    </Drawer>
  );
}
