"use client";

import type { KnowledgeNode } from "@aistudy/contracts";
import Link from "next/link";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";

export const knowledgeKindLabel: Record<KnowledgeNode["kind"], string> = { chapter: "章节", concept: "概念", procedure: "方法", problem_type: "题型" };
export const knowledgeStatusLabel: Record<KnowledgeNode["status"], string> = { suggested: "待核对建议", supported: "已有材料依据", needs_check: "需要核对" };

export type EvidenceTarget =
  | { kind: "material"; href: string; label: string }
  | { kind: "video"; href: string; label: string; startMs: number | null; canSeek: boolean }
  | { kind: "problem"; href: string; label: string }
  | { kind: "evidence"; href: string | null; label: string };

export type EvidenceTargetOptions = {
  libraryHref?: string;
  courseHref?: string;
  /** When true, video CTA opens course media panel (user picks source). */
  courseMediaAvailable?: boolean;
  /** Optional known seek; without it we never claim fake定位. */
  videoStartMs?: number | null;
  videoSourceId?: string | null;
  diagnostics?: boolean;
};

/** Pure: map a knowledge node to navigation targets (material / video / problem / evidence). */
export function evidenceTargetsForNode(
  node: Pick<KnowledgeNode, "id" | "kind" | "label" | "evidenceChunkIds" | "courseId">,
  options?: EvidenceTargetOptions,
): EvidenceTarget[] {
  const library = options?.libraryHref ?? "/opening/library?tab=materials";
  const course = options?.courseHref ?? `/opening/courses/${node.courseId}`;
  const startMs = options?.videoStartMs ?? null;
  const sourceId = options?.videoSourceId ?? null;
  const mediaAvailable = options?.courseMediaAvailable === true;
  const targets: EvidenceTarget[] = [
    { kind: "material", href: `${course}#course-assets`, label: "打开课件材料" },
  ];
  if (node.kind === "problem_type") {
    targets.push({ kind: "problem", href: `${course}#course-practice`, label: "相关练习题目" });
  }

  if (mediaAvailable && startMs != null && sourceId) {
    const params = new URLSearchParams({ mediaSource: sourceId, seekMs: String(startMs) });
    targets.push({
      kind: "video",
      href: `${course}?${params.toString()}#course-media`,
      label: "在课程媒体中定位片段",
      startMs,
      canSeek: true,
    });
  } else if (mediaAvailable) {
    targets.push({
      kind: "video",
      href: `${course}#course-media`,
      label: "打开课程媒体（暂不能自动定位）",
      startMs: null,
      canSeek: false,
    });
  } else {
    targets.push({
      kind: "video",
      href: library,
      label: "仅打开材料库，暂不能定位",
      startMs: null,
      canSeek: false,
    });
  }

  for (const [index, chunkId] of node.evidenceChunkIds.slice(0, 8).entries()) {
    // Course page has no id="evidence-{chunkId}" anchors — do not invent dead hashes (CT-04).
    targets.push({
      kind: "evidence",
      href: null,
      label: `已记录依据 ${options?.diagnostics ? chunkId : index + 1}（当前页无法定位到片段）`,
    });
  }
  if (node.evidenceChunkIds.length === 0) {
    targets.push({
      kind: "evidence",
      href: `${course}#course-knowledge`,
      label: "尚无已保存依据，请先核对材料",
    });
  }
  return targets;
}

export function KnowledgeEvidence({
  node,
  onClose,
  courseMediaAvailable = true,
}: {
  node: KnowledgeNode;
  onClose?: () => void;
  /** Opening course page has a media panel; set false when embedding elsewhere. */
  courseMediaAvailable?: boolean;
}) {
  const diagnostics = useDiagnosticsEnabled();
  const targets = evidenceTargetsForNode(node, { courseMediaAvailable, diagnostics });
  return (
    <section
      className="space-y-2 rounded-lg border border-line bg-surface-2 p-3"
      aria-labelledby={`evidence-panel-${node.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-text" id={`evidence-panel-${node.id}`}>
            {node.label}
          </h3>
          <p className="mt-0.5 text-xs text-text-3">
            {knowledgeKindLabel[node.kind]} · {knowledgeStatusLabel[node.status]}
          </p>
        </div>
        {onClose ? (
          <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center text-xs text-text-2 underline" onClick={onClose}>
            收起
          </button>
        ) : null}
      </div>
      {diagnostics ? <p className="break-all text-xs text-text-2">节点 ID：{node.id} · {node.kind} · {node.status}</p> : null}
      <ul className="space-y-1.5 text-xs leading-5 text-text-2" aria-label="知识依据">
        {targets.map((target) => (
          <li key={`${target.kind}-${target.href ?? "none"}-${target.label}`}>
            {target.href ? (
              <Link
                href={target.href}
                className="inline-flex min-h-11 items-center text-accent underline decoration-accent underline-offset-2 hover:text-text"
              >
                {target.label}
                {target.kind === "video" && target.canSeek && target.startMs != null
                  ? ` · ${Math.floor(target.startMs / 1000)}s`
                  : ""}
              </Link>
            ) : (
              <span className="text-text-2">{target.label}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
