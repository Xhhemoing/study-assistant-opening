"use client";

import type { ActionCandidate, ActionDigest as ActionDigestData } from "@aistudy/contracts";
import { useEffect, useState } from "react";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { buttonClass, secondaryButtonClass } from "../design/ui";
import {
  digestSurfacesPendingOnly,
  emptyActionDigest,
  reduceActionDigestCard,
  type ActionDigestCardModel,
} from "./action-digest-card";

export { digestSurfacesPendingOnly, emptyActionDigest, reduceActionDigestCard };
export type { ActionDigestCardModel };

function mintKey(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}`;
}

/** Primary ≤3; confirmation rows are those needing confirmation (concentrated card). */
export function confirmationCandidates(digest: ActionDigestData): ActionCandidate[] {
  return digest.primary.filter((c) => c.needsConfirmation && c.status === "pending");
}

export function ActionDigest({
  api,
  onChanged,
  onAdjust,
}: {
  api: Pick<OpeningApi, "getActionDigest" | "decideActionDigest">;
  onChanged?: () => void;
  /** Opens plan arrange / adjust without inventing a second planner. */
  onAdjust?: (candidate: ActionCandidate) => void;
}) {
  const [model, setModel] = useState<ActionDigestCardModel>({
    digest: null, error: "", loading: true,
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [basisId, setBasisId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setModel((prev) => reduceActionDigestCard(prev, { type: "load_start" }));
    api.getActionDigest()
      .then((digest) => { if (!cancelled) setModel((prev) => reduceActionDigestCard(prev, { type: "load_ok", digest })); })
      .catch((reason) => {
        if (cancelled) return;
        setModel((prev) => reduceActionDigestCard(prev, {
          type: "load_fail",
          message: reason instanceof Error ? reason.message : "行动摘要暂时无法读取",
        }));
      });
    return () => { cancelled = true; };
  }, [api]);

  const digest = model.digest;
  if (model.loading && !digest) {
    return (
      <section className="border-b border-zinc-200 px-4 py-3" aria-busy="true">
        <p className="text-xs text-zinc-500" role="status">正在读取多源行动…</p>
      </section>
    );
  }
  if (!digest || (digest.primary.length === 0 && digest.pendingConfirmationCount === 0)) {
    return null;
  }

  async function decide(candidate: ActionCandidate, decision: "accept" | "reject") {
    if (pendingId) return;
    setPendingId(candidate.id);
    setModel((prev) => reduceActionDigestCard(prev, { type: "clear_error" }));
    try {
      const result = await api.decideActionDigest({
        decision, candidateId: candidate.id, clientKey: mintKey(`action-${decision}`),
      });
      setModel((prev) => reduceActionDigestCard(prev, { type: "decide_ok", digest: result.digest }));
      onChanged?.();
    } catch (reason) {
      setModel((prev) => reduceActionDigestCard(prev, {
        type: "decide_fail",
        message: reason instanceof OpeningApiError && reason.status === 409
          ? "该建议已处理，请刷新后查看；没有重复提交。"
          : reason instanceof Error ? reason.message : "更新行动建议失败",
      }));
    } finally {
      setPendingId(null);
    }
  }

  const confirmations = confirmationCandidates(digest);

  return (
    <section className="space-y-3 border-b border-sky-200 bg-sky-50/40 px-4 py-4" aria-labelledby="action-digest-heading">
      <div>
        <h3 className="text-xs font-semibold text-zinc-800" id="action-digest-heading">今日优先行动</h3>
        <p className="mt-1 text-[11px] leading-5 text-zinc-500">
          至多 3 项优先行动；需确认项集中在一张确认卡。复用多源摘要，不另建第二套计划。
        </p>
      </div>
      {digest.pendingConfirmationCount > digest.primary.length ? (
        <p className="text-[11px] leading-5 text-amber-900" role="status">
          另有 {digest.pendingConfirmationCount - digest.primary.length} 项待确认（已集中，未全部展开）
        </p>
      ) : null}
      <ul className="space-y-2 text-xs leading-5 text-zinc-700" aria-label="优先行动">
        {digest.primary.map((item) => (
          <li key={item.id} className="rounded-md border border-sky-100 bg-white/80 p-3">
            <span className="font-medium text-zinc-900">{item.title}</span>
            <p className="text-zinc-500">
              {item.minutes} 分钟
              {item.needsConfirmation ? " · 需确认" : ""}
              {item.dueAt ? ` · 截止 ${new Date(item.dueAt).toLocaleString("zh-CN", { hour12: false })}` : ""}
            </p>
          </li>
        ))}
      </ul>
      {confirmations.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3" aria-labelledby="action-confirm-heading">
          <h4 className="text-xs font-semibold text-zinc-900" id="action-confirm-heading">集中确认</h4>
          <p className="mt-1 text-[11px] leading-5 text-zinc-600">接受 / 修改 / 拒绝 / 查看依据。修改会打开今日安排，不另开计划器。</p>
          <ul className="mt-2 space-y-3">
            {confirmations.map((item) => (
              <li key={`confirm-${item.id}`} className="space-y-2">
                <p className="text-xs font-medium text-zinc-900">{item.title}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={buttonClass} disabled={pendingId != null} onClick={() => void decide(item, "accept")}>
                    {pendingId === item.id ? "正在处理…" : "接受"}
                  </button>
                  <button type="button" className={secondaryButtonClass} disabled={pendingId != null} onClick={() => onAdjust?.(item)}>
                    修改
                  </button>
                  <button type="button" className={secondaryButtonClass} disabled={pendingId != null} onClick={() => void decide(item, "reject")}>
                    拒绝
                  </button>
                  <button type="button" className={secondaryButtonClass} aria-expanded={basisId === item.id} onClick={() => setBasisId((id) => (id === item.id ? null : item.id))}>
                    查看依据
                  </button>
                </div>
                {basisId === item.id ? (
                  <p className="text-[11px] leading-5 text-zinc-600" role="status">
                    来源 {item.sourceIds.length ? item.sourceIds.map((id) => id.slice(0, 8)).join("、") : "无"} · dedupe {item.dedupeKey}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {digest.primary.map((item) => (
            <div key={`actions-${item.id}`} className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass} disabled={pendingId != null} onClick={() => void decide(item, "accept")}>接受「{item.title.slice(0, 12)}」</button>
              <button type="button" className={secondaryButtonClass} disabled={pendingId != null} onClick={() => void decide(item, "reject")}>拒绝</button>
            </div>
          ))}
        </div>
      )}
      {model.error ? <p className="text-xs leading-5 text-red-700" role="alert">{model.error}</p> : null}
    </section>
  );
}

/** Backward-compatible alias used by P04 Today wiring. */
export const ActionDigestCard = ActionDigest;
