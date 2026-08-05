"use client";

import type { RevisionProposalRecord } from "@aistudy/contracts";
import { Check, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createRevisionProposalApi, RevisionProposalApiError } from "./revision-proposal-api";

type Props = { documentId: string };

export function RevisionReviewPanel({ documentId }: Props) {
  const api = useMemo(() => createRevisionProposalApi(), []);
  const [proposals, setProposals] = useState<RevisionProposalRecord[]>([]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [selectionInitialized, setSelectionInitialized] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    try { setProposals(await api.list(documentId)); } catch (cause) { setError(cause instanceof RevisionProposalApiError ? cause.message : "暂时无法读取修订提案。"); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [documentId]);

  async function review(proposal: RevisionProposalRecord, action: "accept" | "partial_accept" | "reject") {
    setPending(proposal.id); setError("");
    try {
      const result = await api.review(proposal.id, { action, ...(action === "partial_accept" ? { selectedProposalBlockIds: selected[proposal.id] ?? [] } : {}) });
      setProposals((current) => current.map((item) => item.id === proposal.id ? result.proposal : item));
    } catch (cause) { setError(cause instanceof RevisionProposalApiError ? cause.message : "操作失败，请重试。"); } finally { setPending(null); }
  }
  async function preserve(proposal: RevisionProposalRecord) {
    setPending(proposal.id); setError("");
    try {
      const ids = preserveSelectionIds(proposal, selected[proposal.id] ?? [], Boolean(selectionInitialized[proposal.id]));
      const currentRevision = proposal.conflict?.currentRevisionNumber;
      if (!currentRevision) throw new Error("缺少冲突版本，请重新读取提案。");
      const result = await api.resolve(proposal.id, { action: "preserve_both", selectedProposalBlockIds: ids, expectedCurrentRevisionNumber: currentRevision });
      setProposals((current) => current.map((item) => item.id === proposal.id ? result.proposal : item));
    } catch (cause) { setError(cause instanceof RevisionProposalApiError ? cause.message : cause instanceof Error ? cause.message : "操作失败，请重试。"); } finally { setPending(null); }
  }

  if (loading) return <section className="rounded-lg border border-line bg-surface p-4" aria-label="修订提案"><p role="status" className="text-sm text-text-dim">正在读取修订提案...</p></section>;
  return <section className="rounded-lg border border-line bg-surface p-4" aria-label="修订提案审核">
    <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold text-text">修订提案</h2><p className="text-xs text-text-dim">{proposals.length ? `${proposals.length} 个提案` : "没有待审核提案"}</p></div><button className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border border-line text-text-dim hover:bg-surface-2" type="button" onClick={() => void load()} aria-label="重试读取修订提案" title="重试"><RefreshCw aria-hidden="true" size={16} /></button></div>
    {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
    <div className="mt-3 space-y-3">{proposals.map((proposal) => <ProposalItem key={proposal.id} proposal={proposal} selected={proposal.status === "conflicted" ? preserveSelectionIds(proposal, selected[proposal.id] ?? [], Boolean(selectionInitialized[proposal.id])) : selected[proposal.id] ?? []} onSelect={(ids) => { setSelectionInitialized((current) => ({ ...current, [proposal.id]: true })); setSelected((current) => ({ ...current, [proposal.id]: ids })); }} pending={pending === proposal.id} onReview={review} onPreserve={preserve} />)}</div>
  </section>;
}

export function selectableProposalBlockIds(proposal: Pick<RevisionProposalRecord, "diff">): string[] {
  return proposal.diff.filter((entry) => entry.proposed !== null).map((entry) => entry.blockId);
}

export function preserveSelectionIds(
  proposal: Pick<RevisionProposalRecord, "diff">,
  selected: string[],
  selectionInitialized: boolean,
): string[] {
  return selectionInitialized ? selected : selectableProposalBlockIds(proposal);
}

function ProposalItem({ proposal, selected, onSelect, pending, onReview, onPreserve }: { proposal: RevisionProposalRecord; selected: string[]; onSelect: (ids: string[]) => void; pending: boolean; onReview: (proposal: RevisionProposalRecord, action: "accept" | "partial_accept" | "reject") => void; onPreserve: (proposal: RevisionProposalRecord) => void }) {
  const selectable = new Set(selectableProposalBlockIds(proposal));
  return <article className="border-t border-line pt-3 first:border-t-0 first:pt-0"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-medium text-text">{proposal.proposedTitle ?? proposal.baseTitle}</h3><span className="text-xs text-text-dim">{proposal.status} · v{proposal.baseRevisionNumber} · {proposal.source.kind}/{proposal.supportState}</span></div><ul className="mt-2 space-y-1 text-xs text-text-dim">{proposal.diff.map((entry) => <li key={entry.blockId} className="flex items-center gap-2"><span className="w-16">{entry.kind}</span><label className="inline-flex min-h-10 items-center gap-2"><input type="checkbox" aria-label={`选择块 ${entry.blockId}`} checked={selected.includes(entry.blockId)} disabled={(proposal.status !== "pending" && proposal.status !== "conflicted") || pending || !selectable.has(entry.blockId)} onChange={(event) => onSelect(event.target.checked ? [...selected, entry.blockId] : selected.filter((id) => id !== entry.blockId))} />{entry.blockId}</label></li>)}</ul>{proposal.status === "conflicted" ? <div className="mt-2 flex items-center gap-2 text-xs text-danger"><X aria-hidden="true" size={14} />当前版本为 v{proposal.conflict?.currentRevisionNumber}</div> : null}<div className="mt-3 flex flex-wrap gap-2"><button className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-3 text-xs font-semibold text-ink disabled:opacity-50" type="button" disabled={pending || proposal.status !== "pending"} onClick={() => onReview(proposal, "accept")}><Check aria-hidden="true" size={14} />接受</button><button className="min-h-10 rounded-md border border-line px-3 py-2 text-xs text-text disabled:opacity-50" type="button" disabled={pending || proposal.status !== "pending" || selected.length === 0} onClick={() => onReview(proposal, "partial_accept")}>接受所选</button><button className="min-h-10 rounded-md border border-line px-3 text-xs text-text disabled:opacity-50" type="button" disabled={pending || proposal.status !== "pending"} onClick={() => onReview(proposal, "reject")}>拒绝</button>{proposal.status === "conflicted" ? <button className="min-h-10 rounded-md border border-primary px-3 text-xs text-text disabled:opacity-50" type="button" disabled={pending} onClick={() => onPreserve(proposal)}>保留两者</button> : null}</div></article>;
}
