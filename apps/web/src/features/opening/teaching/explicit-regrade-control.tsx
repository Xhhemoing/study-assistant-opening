"use client";

import { useSyncExternalStore } from "react";
import { EXPLICIT_REGRADE_CONFIRMATION_TEXT } from "@aistudy/contracts";
import { ui } from "../design/ui";
import type { ExplicitRegradeOwner, ExplicitRegradeState } from "./explicit-regrade-client";

const messages: Record<ExplicitRegradeState["phase"], string> = {
  idle: "旧 AI 评改的费用或发送结果未知，不会自动重发。你可以为同一份答案新建一次 AI 评改。",
  preparing: "正在准备新评改信息，尚未确认本次另行收费。",
  prepared: "请核对费用，再明确确认这一次新的 AI 评改。",
  confirming: "正在确认本次新评改，请勿重复操作；不会取消旧请求或释放其未决费用。",
  confirmed: "新评改确认已保存，尚未确认进入队列。不会将确认记录当作已调用 AI。请读取状态。",
  pending: "新评改正在后台处理；离开本页不会取消。旧请求的未决费用仍保留。",
  graded: "新 AI 评改已完成。原答案、照片和旧评改历史仍保留，旧请求费用不因此确认或释放。",
  unknown: "新评改的费用或发送结果也未确认。不会重发本次请求；旧请求费用仍未释放。",
  manual: "新评改暂不能给出确定结果，不会自动重发。原答案和两次评改历史保留。",
  unconfirmed: "操作结果尚未确认，可能已保存或产生费用。不会自动重发；请只读取本次状态。",
  conflict: "作答、隐私状态或评改版本已变化。旧响应未用于再次收费，请重新读取当前记录与本次状态。",
};

/** Owner injection is required: no invented route, automatic prepare, confirm or retry. */
export function ExplicitRegradeControl({ owner, disabled = false }: { owner: ExplicitRegradeOwner; disabled?: boolean }) {
  const { session, snapshot } = owner;
  const state = useSyncExternalStore(session.subscribe, () => session.get(snapshot), () => session.get(snapshot));
  if (snapshot.oldStatus !== "unknown_cost" && state.phase === "idle") return null;
  const busy = state.reading || state.phase === "preparing" || state.phase === "confirming";
  const request = state.request;
  return <section aria-label="新建 AI 评改版本" aria-busy={Boolean(busy)} className="min-w-0 space-y-3 border-t border-line pt-3">
    <p role="status" className="text-sm leading-6 text-text-2">{messages[state.phase]}</p>
    {request ? <div className="space-y-1 text-sm leading-6 text-text-2">
      <p>新 AI 评改版本：{request.gradingVersion} · 答案仍为原版本，不改写原答案或照片。</p>
      <p className="break-all">本次请求：{request.requestId}</p>
    </div> : null}
    {state.phase === "prepared" ? <div className="space-y-3">
      <p className="text-sm font-medium leading-6 text-warn">{EXPLICIT_REGRADE_CONFIRMATION_TEXT}</p>
      <p className="text-sm leading-6 text-text-2">本次价格估算：{state.estimate?.trim() || "暂不可用；不能确认收费，请重新读取。"}。估算不代表最终费用。</p>
      <p className="text-sm leading-6 text-text-2">旧未知费用不会因新建评改而释放。沿用已保存的同一答案与照片；两次都可能收费。</p>
      <button type="button" className={`${ui.primary} h-auto min-h-11 whitespace-normal text-left`} disabled={disabled || busy || snapshot.oldStatus !== "unknown_cost" || !state.estimate?.trim()}
        onClick={() => { void session.confirm(snapshot); }}>确认新建 AI 评改（这次另收费，旧未知费用不释放）</button>
    </div> : null}
    {state.phase === "idle" ? <button type="button" className={`${ui.secondary} h-auto min-h-11 whitespace-normal`} disabled={disabled || busy}
      onClick={() => { void session.prepare(snapshot); }}>新建一次AI评改版本</button> : null}
    {!["idle", "preparing", "confirming"].includes(state.phase) ? <button type="button" className={`${ui.secondary} h-auto min-h-11 whitespace-normal`} disabled={disabled || busy}
      onClick={() => { void session.read(snapshot); }}>{state.reading ? "正在读取本次状态…" : "重新读取本次评改状态（不调用 AI）"}</button> : null}
    {state.readFailed ? <p role="alert" className="text-sm leading-6 text-danger">状态读取失败；原答案与请求仍保留，可再次读取，不会重发收费请求。</p> : null}
  </section>;
}
