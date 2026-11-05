"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import type { KnowledgeNode } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { secondaryButtonClass } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";

type KnowledgeRecord = Awaited<ReturnType<OpeningApi["getCourseKnowledge"]>>;

export function ConfirmKnowledgeNode({ node, record, api, onConfirmed, onReload }: {
  node: KnowledgeNode;
  record: KnowledgeRecord;
  api: Pick<OpeningApi, "confirmKnowledgeNode">;
  onConfirmed(record: KnowledgeRecord): void;
  onReload(): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  if (node.status !== "needs_check") return confirmed ? <p role="status" className="text-xs text-text-2">已确认材料依据，不代表已掌握。</p> : null;

  async function confirm() {
    if (pending) return;
    setPending(true); setError("");
    try {
      const next = await api.confirmKnowledgeNode(node.courseId, {
        nodeId: node.id, expectedVersion: record.version, sourceVersions: record.sourceVersions,
      });
      onConfirmed(next);
      setConfirmed(true);
    } catch (reason) {
      setError(userFacingMessage(reason, "确认未保存，请重新读取并核对材料后再试。"));
    } finally {
      setPending(false);
    }
  }

  return <div className="w-full space-y-2 border-t border-line pt-2">
    <p id={`confirm-meaning-${node.id}`} className="text-xs leading-5 text-text-3">
      核对材料后，可将此知识点标为已有材料依据，用于后续学习建议。这不代表已掌握；材料变化后需要重新核对。
    </p>
    <button type="button" className={secondaryButtonClass} disabled={pending || !node.evidenceChunkIds.length}
      aria-busy={pending} aria-describedby={`confirm-meaning-${node.id}`} onClick={() => void confirm()}>
      <Check size={14} aria-hidden="true" />{pending ? "正在保存确认…" : "我已核对，确认材料依据"}
    </button>
    {!node.evidenceChunkIds.length ? <p className="text-xs text-text-3">尚无已保存依据，请先补充材料。</p> : null}
    {error ? <div role="alert" className="space-y-1 text-xs text-text-2">
      <p>{error}</p>
      <button type="button" className={secondaryButtonClass} onClick={onReload}>重新读取课程知识</button>
    </div> : null}
  </div>;
}
