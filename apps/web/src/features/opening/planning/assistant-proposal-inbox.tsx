"use client";
import { useMemo, useRef, useState } from "react";
import type { AssistantProposalDecision, AssistantProposalRecord } from "@aistudy/contracts";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { PlanProposalPreview, proposalLabels, proposalText } from "../assistant/proposal-panel";
import { usePendingProposals } from "../assistant/use-pending-proposals";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { buttonClass, secondaryButtonClass } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";

type InboxApi = Pick<OpeningApi, "listPendingAssistantProposals" | "decideAssistantProposal">;
function createDecisions(api: InboxApi) {
  const pending = new Map<string, AssistantProposalDecision>();
  const key = (row: AssistantProposalRecord) => `${row.id}:${row.version}`;
  return {
    pending: (row: AssistantProposalRecord) => pending.get(key(row)),
    retain: (row: AssistantProposalRecord) => pending.has(key(row)),
    async submit(row: AssistantProposalRecord, action: "accept" | "reject") {
      const id = key(row);
      let intent = pending.get(id);
      if (intent && intent.action !== action) throw new Error("上次结果尚未确认，请先重试原操作。");
      if (!intent) { intent = { expectedVersion: row.version, action, clientKey: `proposal-decision:${row.id}:${row.version}:${action}` }; pending.set(id, intent); }
      try { const result = await api.decideAssistantProposal(row.id, intent); pending.delete(id); return result; }
      catch (error) {
        if (error instanceof OpeningApiError && (error.status === 400 || error.status === 422)) pending.delete(id);
        throw error;
      }
    },
  };
}
function ProposalCard({ row, actions }: { row: AssistantProposalRecord; actions: ReturnType<typeof createDecisions> }) {
  const intent = actions.pending(row);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AssistantProposalRecord | null>(null);
  async function decide(action: "accept" | "reject") {
    if (running.current || result || intent && intent.action !== action) return;
    running.current = true; setBusy(true); setError("");
    try { setResult(await actions.submit(row, action)); }
    catch (cause) {
      setError(userFacingMessage(cause, "结果尚未确认，请重试原操作。"));
    } finally { running.current = false; setBusy(false); }
  }
  return <li className="space-y-2 border-b border-line py-4">
    <h3 className="text-sm font-semibold">{proposalLabels[row.tool.name]}</h3>
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{proposalText(row)}</p>
    {row.tool.name === "propose_plan_change" ? <PlanProposalPreview row={row} /> : null}
    {error ? <p role="alert" className="text-sm text-warn">{error}</p> : null}
    {result ? <p role="status" className="text-sm">{result.status === "accepted" ? "已接受" : "未采用"}</p> : <div className="flex gap-2">
      <button data-action="accept" className={buttonClass} disabled={busy || intent?.action === "reject" || row.tool.name === "propose_plan_change" && !row.prepared?.preview} onClick={() => void decide("accept")}>{error && intent?.action === "accept" ? "重试接受" : "接受建议"}</button>
      <button data-action="reject" className={secondaryButtonClass} disabled={busy || intent?.action === "accept"} onClick={() => void decide("reject")}>{error && intent?.action === "reject" ? "重试不采用" : "不采用"}</button>
    </div>}
    {result?.result?.href.startsWith("/") && !result.result.href.startsWith("//") ? <Link href={result.result.href} className={secondaryButtonClass}>查看结果</Link> : null}
  </li>;
}

export function AssistantProposalInbox({ api }: { api: InboxApi }) {
  const actions = useMemo(() => createDecisions(api), [api]);
  const state = usePendingProposals(api, { retain: actions.retain });
  return <section aria-label="对话建议收件箱" className="mx-auto max-w-4xl px-5 pb-5 sm:px-7">
    <h2 className="text-sm font-semibold">对话建议{state.total ? ` · ${state.total} 项` : ""}</h2>
    {state.error ? <div role="alert" className="space-y-2 py-3"><p className="text-sm text-warn">{state.error} 读取失败不代表没有待确认建议。</p>
      <button className={secondaryButtonClass} onClick={() => void state.refresh()}>重新读取建议</button></div> : null}
    {state.loading ? <p role="status" className="py-3 text-sm text-text-2">正在读取建议…</p> : null}
    {!state.loading && !state.error && !state.rows.length ? <p className="py-3 text-sm text-text-2">暂无待确认的对话建议。</p> : null}
    <ul>{state.rows.map(row => <ProposalCard key={`${row.id}:${row.version}`} row={row} actions={actions} />)}</ul>
    {state.cursor ? <button className={secondaryButtonClass} disabled={state.loading} onClick={() => void state.loadMore()}>读取更多建议</button> : null}
  </section>;
}
