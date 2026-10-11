"use client";

import type { KnowledgeNode } from "@aistudy/contracts";
import Link from "next/link";

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

  for (const chunkId of node.evidenceChunkIds.slice(0, 8)) {
    // Course page has no id="evidence-{chunkId}" anchors — do not invent dead hashes (CT-04).
    targets.push({
      kind: "evidence",
      href: null,
      label: `已记录依据 ${chunkId.slice(0, 8)}…（课程页无片段锚点）`,
    });
  }
  if (node.evidenceChunkIds.length === 0) {
    targets.push({
      kind: "evidence",
      href: `${course}#course-knowledge`,
      label: "尚无已保存依据（suggested 节点）",
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
  const targets = evidenceTargetsForNode(node, { courseMediaAvailable });
  return (
    <section
      className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3"
      aria-labelledby={`evidence-panel-${node.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-zinc-900" id={`evidence-panel-${node.id}`}>
            {node.label}
          </h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {node.kind} · {node.status}
            {node.status === "supported" ? "" : " · 不显示掌握百分比"}
          </p>
        </div>
        {onClose ? (
          <button type="button" className="text-xs text-zinc-600 underline" onClick={onClose}>
            收起
          </button>
        ) : null}
      </div>
      <ul className="space-y-1.5 text-xs leading-5 text-zinc-700" aria-label="知识依据">
        {targets.map((target) => (
          <li key={`${target.kind}-${target.href ?? "none"}-${target.label}`}>
            {target.href ? (
              <Link
                href={target.href}
                className="text-emerald-800 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-950"
              >
                {target.label}
                {target.kind === "video" && target.canSeek && target.startMs != null
                  ? ` · ${Math.floor(target.startMs / 1000)}s`
                  : ""}
              </Link>
            ) : (
              <span className="text-zinc-600">{target.label}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
