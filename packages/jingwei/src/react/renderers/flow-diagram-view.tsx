"use client";

import { FLOW_RELATION_LABELS, flowDiagramToText, type FlowDiagramParams } from "../../capabilities/flow-diagram";
import type { RendererProps } from "../artifact-view";

/** Node order for a chain; null when the graph is not a simple path (rendered as text instead). */
export function chainOrder({ nodes, edges }: FlowDiagramParams): FlowDiagramParams["nodes"] | null {
  if (edges.length !== nodes.length - 1) return null;
  const next = new Map(edges.map((edge) => [edge.from, edge]));
  const targets = new Set(edges.map((edge) => edge.to));
  const start = nodes.find((node) => !targets.has(node.id));
  if (!start || next.size !== edges.length) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered = [start];
  while (next.has(ordered.at(-1)!.id)) {
    const node = byId.get(next.get(ordered.at(-1)!.id)!.to)!;
    if (ordered.includes(node)) return null;
    ordered.push(node);
  }
  return ordered.length === nodes.length ? ordered : null;
}

export function FlowDiagramView({ params }: RendererProps<FlowDiagramParams>) {
  const ordered = chainOrder(params);
  if (!ordered) {
    // Branching layouts are not supported yet; keep the readable relation list.
    return <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-800">{flowDiagramToText(params)}</p>;
  }
  const incoming = new Map(params.edges.map((edge) => [edge.to, edge.relation]));
  return (
    <ol className="flex flex-col items-stretch gap-0" aria-label="流程图">
      {ordered.map((node, index) => {
        const relation = incoming.get(node.id);
        const hypothesis = relation === "hypothesis";
        return (
          <li key={node.id} className="flex flex-col items-center">
            {relation ? (
              <span className="flex h-7 flex-col items-center text-[11px] leading-none text-zinc-400" aria-hidden="true">
                <span className={`h-3 border-l ${hypothesis ? "border-dashed border-amber-400" : "border-zinc-300"}`} />
                {relation === "sequence" ? "↓" : `↓ ${FLOW_RELATION_LABELS[relation]}`}
              </span>
            ) : null}
            <span
              className={`flex w-full max-w-sm items-center gap-2.5 rounded-lg border bg-white px-3 py-2 text-sm leading-6 text-zinc-800 shadow-xs ${
                hypothesis ? "border-dashed border-amber-300" : "border-zinc-200"
              }`}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-medium tabular-nums text-white">
                {index + 1}
              </span>
              <span className="min-w-0 break-words">{node.label}</span>
              {relation && relation !== "sequence" ? <span className="sr-only">（与上一步的关系：{FLOW_RELATION_LABELS[relation]}）</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
