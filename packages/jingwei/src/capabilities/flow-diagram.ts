import { z } from "zod";
import { defineCapability } from "../capability";

export const FLOW_DIAGRAM_ID = "flow-diagram@1";

/** Arrows are not one grammar: order ≠ cause, hypothesis ≠ verified. */
export const FLOW_RELATIONS = ["sequence", "dependency", "contains", "reference", "hypothesis"] as const;
export type FlowRelation = (typeof FLOW_RELATIONS)[number];

export const FLOW_RELATION_LABELS: Record<FlowRelation, string> = {
  sequence: "然后",
  dependency: "依赖",
  contains: "包含",
  reference: "引用",
  hypothesis: "假设",
};

export const flowDiagramParamsSchema = z
  .object({
    nodes: z
      .array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), label: z.string().trim().min(1).max(40) }).strict())
      .min(2)
      .max(12),
    edges: z
      .array(z.object({ from: z.string(), to: z.string(), relation: z.enum(FLOW_RELATIONS) }).strict())
      .max(24),
  })
  .strict()
  .superRefine(({ nodes, edges }, ctx) => {
    const ids = new Set<string>();
    nodes.forEach((node, index) => {
      if (ids.has(node.id)) ctx.addIssue({ code: "custom", message: `duplicate node ${node.id}`, path: ["nodes", index, "id"] });
      ids.add(node.id);
    });
    edges.forEach((edge, index) => {
      if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) {
        ctx.addIssue({ code: "custom", message: "edge endpoints must be two distinct known nodes", path: ["edges", index] });
      }
    });
  });

export type FlowDiagramParams = z.infer<typeof flowDiagramParamsSchema>;

export function flowDiagramToText({ nodes, edges }: FlowDiagramParams): string {
  const label = new Map(nodes.map((node) => [node.id, node.label]));
  const isChain =
    edges.length === nodes.length - 1 &&
    edges.every((edge, i) => edge.relation === "sequence" && edge.from === nodes[i]!.id && edge.to === nodes[i + 1]!.id);
  if (isChain) return nodes.map((node, i) => `${i + 1}. ${node.label}`).join("\n");
  const lines = nodes.map((node) => `· ${node.label}`);
  for (const edge of edges) {
    lines.push(`${label.get(edge.from)} →（${FLOW_RELATION_LABELS[edge.relation]}）${label.get(edge.to)}`);
  }
  return lines.join("\n");
}

export const flowDiagramCapability = defineCapability<FlowDiagramParams>({
  id: FLOW_DIAGRAM_ID,
  title: "流程与关系图",
  tasks: ["structure", "process"],
  modes: ["text", "static"],
  params: flowDiagramParamsSchema,
  limits: ["箭头类型需标明；顺序不等于因果，假设不等于已验证"],
  toText: flowDiagramToText,
});
