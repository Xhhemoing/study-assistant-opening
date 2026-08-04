"use client";

import { Link2, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { ManagedRelation, RelationType } from "@aistudy/contracts";
import { createDocumentRelationsApi } from "./document-relations-api";

const relationTypes: RelationType[] = ["references", "supports", "embeds", "derived_from", "related"];

type RelationState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; relations: ManagedRelation[] };

function targetLabel(relation: ManagedRelation): string {
  if (relation.to.status === "broken") return "链接目标已失效";
  if (relation.to.type === "block" && relation.to.text) {
    return `${relation.to.title ?? "未命名笔记"} · ${relation.to.text}`;
  }
  return relation.to.title ?? "未命名笔记";
}

export function RelationAuthoringPanel({ documentId }: { documentId: string }) {
  const api = useMemo(() => createDocumentRelationsApi(), []);
  const [state, setState] = useState<RelationState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [targetType, setTargetType] = useState<"document" | "block">("document");
  const [targetId, setTargetId] = useState("");
  const [relationType, setRelationType] = useState<RelationType>("references");
  const [pending, setPending] = useState(false);
  const [writeError, setWriteError] = useState("");

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    setWriteError("");
    api.list(documentId)
      .then((relations) => {
        if (active) setState({ status: "ready", relations });
      })
      .catch(() => {
        if (active) setState({ status: "error", message: "关系暂时无法读取。" });
      });
    return () => { active = false; };
  }, [api, documentId, reloadToken]);

  async function createRelation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !targetId.trim()) return;
    setPending(true);
    setWriteError("");
    try {
      const relation = await api.create(documentId, { type: targetType, id: targetId.trim() }, relationType);
      setState((current) => current.status === "ready"
        ? {
          status: "ready",
          relations: current.relations.some((item) => item.id === relation.id)
            ? current.relations.map((item) => item.id === relation.id ? relation : item)
            : [...current.relations, relation],
        }
        : current);
      setTargetId("");
    } catch {
      setWriteError("关系保存失败，请检查目标后重试。");
    } finally {
      setPending(false);
    }
  }

  async function updateRelation(relationId: string, nextType: RelationType) {
    if (pending) return;
    setPending(true);
    setWriteError("");
    try {
      const relation = await api.update(documentId, relationId, nextType);
      setState((current) => current.status === "ready"
        ? { status: "ready", relations: current.relations.map((item) => item.id === relation.id ? relation : item) }
        : current);
    } catch {
      setWriteError("关系类型更新失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  async function removeRelation(relationId: string) {
    if (pending) return;
    setPending(true);
    setWriteError("");
    try {
      await api.remove(documentId, relationId);
      setState((current) => current.status === "ready"
        ? { status: "ready", relations: current.relations.filter((item) => item.id !== relationId) }
        : current);
    } catch {
      setWriteError("关系删除失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="document-relations-title">
      <div className="mb-3 flex items-center gap-2"><Link2 aria-hidden="true" className="text-primary" size={16} /><h2 className="text-sm font-semibold text-text" id="document-relations-title">关联笔记</h2></div>
      {state.status === "loading" ? <p className="mb-3 text-xs text-text-dim" role="status">正在读取关联...</p> : null}
      {state.status === "error" ? <div className="mb-3 flex items-center gap-2" role="alert"><p className="text-xs text-danger">{state.message}</p><button aria-label="重试读取关联" className="inline-grid size-8 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={reload} title="重试读取关联" type="button"><RefreshCw aria-hidden="true" size={14} /></button></div> : null}
      {state.status === "ready" && state.relations.length === 0 ? <p className="mb-3 text-xs text-text-dim">还没有从这篇笔记发出的关联</p> : null}
      {state.status === "ready" && state.relations.length > 0 ? <ul className="mb-3 grid gap-2">{state.relations.map((relation) => {
        const label = targetLabel(relation);
        const target = relation.to.status === "available" && relation.to.documentId
          ? <Link className="truncate hover:text-primary" href={`/library/${encodeURIComponent(relation.to.documentId)}`}>{label}</Link>
          : <span className="truncate">{label}</span>;
        return <li className="grid gap-2 rounded-md border border-line p-2" key={relation.id}>
          <div className="min-w-0 text-sm text-text">{target}</div>
          <div className="flex items-center gap-2"><label className="min-w-0 flex-1"><span className="sr-only">已有关联类型</span><select className="w-full rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-text outline-none focus:border-primary disabled:opacity-50" disabled={pending} onChange={(event) => void updateRelation(relation.id, event.target.value as RelationType)} value={relation.relationType}>{relationTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><button aria-label={`删除关联 ${label}`} className="inline-grid size-8 shrink-0 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 hover:text-danger disabled:opacity-40" disabled={pending} onClick={() => void removeRelation(relation.id)} title="删除关联" type="button"><Trash2 aria-hidden="true" size={15} /></button></div>
        </li>;
      })}</ul> : null}
      <form className="grid gap-2" onSubmit={(event) => void createRelation(event)}>
        <div className="grid grid-cols-2 gap-2" aria-label="目标类型"><button aria-pressed={targetType === "document"} className="rounded-md border border-line px-2 py-1.5 text-xs text-text-dim hover:bg-surface-2 aria-pressed:border-primary aria-pressed:text-text disabled:opacity-40" disabled={pending} onClick={() => setTargetType("document")} type="button">笔记</button><button aria-pressed={targetType === "block"} className="rounded-md border border-line px-2 py-1.5 text-xs text-text-dim hover:bg-surface-2 aria-pressed:border-primary aria-pressed:text-text disabled:opacity-40" disabled={pending} onClick={() => setTargetType("block")} type="button">区块</button></div>
        <div className="flex gap-2"><label className="min-w-0 flex-1"><span className="sr-only">关联目标 ID</span><input className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-text outline-none placeholder:text-text-dim focus:border-primary disabled:opacity-50" disabled={pending} onChange={(event) => setTargetId(event.target.value)} placeholder="输入目标 ID" value={targetId} /></label><label className="w-28 shrink-0"><span className="sr-only">新关联类型</span><select className="w-full rounded-md border border-line bg-ink px-2 py-2 text-xs text-text outline-none focus:border-primary disabled:opacity-50" disabled={pending} onChange={(event) => setRelationType(event.target.value as RelationType)} value={relationType}>{relationTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><button aria-label="创建关联" className="inline-grid size-10 shrink-0 place-items-center rounded-md border border-line text-text-dim hover:bg-surface-2 hover:text-text disabled:opacity-40" disabled={pending || !targetId.trim() || state.status !== "ready"} title="创建关联" type="submit"><Plus aria-hidden="true" size={16} /></button></div>
      </form>
      {writeError ? <p className="mt-2 text-xs text-danger" role="alert">{writeError}</p> : null}
    </section>
  );
}
