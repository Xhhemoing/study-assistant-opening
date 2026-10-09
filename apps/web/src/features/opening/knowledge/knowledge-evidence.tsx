"use client";

import type { KnowledgeNode } from "@aistudy/contracts";
import Link from "next/link";

export type EvidenceTarget =
  | { kind: "material"; href: string; label: string }
  | { kind: "video"; href: string; label: string; startMs: number | null }
  | { kind: "problem"; href: string; label: string }
  | { kind: "evidence"; href: string; label: string };

/** Pure: map a knowledge node to navigation targets (material / video / problem / evidence). */
export function evidenceTargetsForNode(
  node: Pick<KnowledgeNode, "id" | "kind" | "label" | "evidenceChunkIds" | "courseId">,
  options?: { libraryHref?: string; courseHref?: string },
): EvidenceTarget[] {
  const library = options?.libraryHref ?? "/opening/library?tab=materials";
  const course = options?.courseHref ?? `/opening/courses/${node.courseId}`;
  const targets: EvidenceTarget[] = [
    { kind: "material", href: `${course}#course-assets`, label: "打开课件材料" },
  ];
  if (node.kind === "problem_type") {
    targets.push({ kind: "problem", href: `${course}#course-practice`, label: "相关练习题目" });
  }
  targets.push({
    kind: "video",
    href: `${library}`,
    label: "视频时间定位（需在材料中打开片段）",
    startMs: null,
  });
  for (const chunkId of node.evidenceChunkIds.slice(0, 8)) {
    targets.push({
      kind: "evidence",
      href: `${course}#evidence-${chunkId}`,
      label: `依据 ${chunkId.slice(0, 8)}…`,
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
}: {
  node: KnowledgeNode;
  onClose?: () => void;
}) {
  const targets = evidenceTargetsForNode(node);
  return (
    <section
      className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3"
      aria-labelledby={`evidence-${node.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-zinc-900" id={`evidence-${node.id}`}>
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
          <li key={`${target.kind}-${target.href}-${target.label}`}>
            <Link
              href={target.href}
              className="text-emerald-800 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-950"
            >
              {target.label}
              {target.kind === "video" && target.startMs != null
                ? ` · ${Math.floor(target.startMs / 1000)}s`
                : ""}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
