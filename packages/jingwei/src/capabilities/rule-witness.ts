import { z } from "zod";
import { defineCapability, type Capability } from "../capability";

const serializedBytes = (value: unknown): number => { try { return new TextEncoder().encode(JSON.stringify(value) ?? "").length; } catch { return Number.POSITIVE_INFINITY; } };
const witnessBase = z.object({ origin: z.literal("rules"), allowedActions: z.array(z.never()).max(0).default([]) }).strict();

export const FUNCTION_DIFF_PLOT_ID = "function-diff-plot@1";
export const functionDiffPlotParamsSchema = witnessBase.extend({
  title: z.string().trim().min(1).max(160),
  points: z.array(z.object({ x: z.string().max(80), student: z.string().max(160).optional(), reference: z.string().max(160).optional(), kind: z.enum(["discontinuity", "derivative_residual", "bound_mismatch"]) }).strict()).max(256),
  explanation: z.string().max(12000),
}).strict().superRefine((value, ctx) => { if (serializedBytes(value) > 49_152) ctx.addIssue({ code: "custom", message: "rule witness payload exceeds 48 KiB" }); });
export type FunctionDiffPlotParams = z.infer<typeof functionDiffPlotParamsSchema>;
export const functionDiffPlotCapability = defineCapability<FunctionDiffPlotParams>({ id: FUNCTION_DIFF_PLOT_ID, title: "函数差异规则见证", tasks: ["compare", "practice"], modes: ["text", "static"], params: functionDiffPlotParamsSchema, actions: [], limits: ["规则生成的局部反例，仅用于解释差异"], hostOnly: false, toText: (value) => `${value.title}\n${value.points.map((point) => `x=${point.x}: ${point.kind} ${point.student ?? "?"} / ${point.reference ?? "?"}`).join("\n")}\n${value.explanation}` });

export const SUBSPACE_ROW_TRACE_ID = "subspace-row-trace@1";
export const subspaceRowTraceParamsSchema = witnessBase.extend({
  title: z.string().trim().min(1).max(160),
  pivots: z.array(z.object({ step: z.number().int().nonnegative(), operation: z.string().max(240), matrix: z.array(z.array(z.string().max(80)).max(64)).max(64) }).strict()).max(256),
  dependency: z.array(z.string().max(120)).max(64).optional(),
  explanation: z.string().max(12000),
}).strict().superRefine((value, ctx) => { if (serializedBytes(value) > 49_152) ctx.addIssue({ code: "custom", message: "rule witness payload exceeds 48 KiB" }); });
export type SubspaceRowTraceParams = z.infer<typeof subspaceRowTraceParamsSchema>;
export const subspaceRowTraceCapability = defineCapability<SubspaceRowTraceParams>({ id: SUBSPACE_ROW_TRACE_ID, title: "子空间行变换规则见证", tasks: ["structure", "practice"], modes: ["text", "static"], params: subspaceRowTraceParamsSchema, actions: [], limits: ["显示精确行变换与维数见证，不提供写入动作"], hostOnly: false, toText: (value) => `${value.title}\n${value.pivots.map((pivot) => `${pivot.step}. ${pivot.operation}\n${pivot.matrix.map((row) => `[${row.join(", ")}]`).join("\n")}`).join("\n")}\n${value.dependency ? `依赖见证: ${value.dependency.join(", ")}\n` : ""}${value.explanation}` });

export const DS_POINTER_STEP_ID = "ds-pointer-step@1";
export const dsPointerStepParamsSchema = witnessBase.extend({
  title: z.string().trim().min(1).max(160),
  before: z.array(z.object({ id: z.string().max(80), next: z.string().max(80).nullable() }).strict()).max(256),
  after: z.array(z.object({ id: z.string().max(80), next: z.string().max(80).nullable() }).strict()).max(256),
  severed: z.array(z.string().max(80)).max(256).default([]),
  dangling: z.array(z.string().max(80)).max(256).default([]),
  explanation: z.string().max(12000),
}).strict().superRefine((value, ctx) => { if (serializedBytes(value) > 49_152) ctx.addIssue({ code: "custom", message: "rule witness payload exceeds 48 KiB" }); });
export type DsPointerStepParams = z.infer<typeof dsPointerStepParamsSchema>;
export const dsPointerStepCapability = defineCapability<DsPointerStepParams>({ id: DS_POINTER_STEP_ID, title: "指针步骤规则见证", tasks: ["process", "practice"], modes: ["text", "static"], params: dsPointerStepParamsSchema, actions: [], limits: ["显示指针突变前后图，仅用于规则解释"], hostOnly: false, toText: (value) => `${value.title}\n前: ${value.before.map((node) => `${node.id}->${node.next ?? "null"}`).join(" | ")}\n后: ${value.after.map((node) => `${node.id}->${node.next ?? "null"}`).join(" | ")}\n${value.severed.length ? `断链: ${value.severed.join(", ")}\n` : ""}${value.dangling.length ? `悬空: ${value.dangling.join(", ")}\n` : ""}${value.explanation}` });

export const PROPOSAL_DIFF_ID = "proposal-diff@1";
export const proposalDiffParamsSchema = z.object({
  aiCandidateOnly: z.literal(true),
  title: z.string().trim().min(1).max(160),
  revisions: z.array(z.object({ path: z.string().min(1).max(200), before: z.string().max(12000).nullable(), after: z.string().max(12000).nullable(), kind: z.enum(["note", "flashcard", "schedule"]) }).strict()).min(1).max(128),
  undo: z.object({ token: z.string().min(1).max(200), compensates: z.array(z.string().max(200)).max(128) }).strict(),
}).strict().superRefine((value, ctx) => { if (serializedBytes(value) > 49_152) ctx.addIssue({ code: "custom", message: "proposal diff payload exceeds 48 KiB" }); });
export type ProposalDiffParams = z.infer<typeof proposalDiffParamsSchema>;
export const proposalDiffCapability = defineCapability<ProposalDiffParams>({ id: PROPOSAL_DIFF_ID, title: "候选修订差异", tasks: ["compare", "practice"], modes: ["text", "static"], params: proposalDiffParamsSchema, actions: [], limits: ["仅呈现 AI 候选变更与补偿撤销元数据"], hostOnly: true, aiCandidateOnly: true, toText: (value) => `${value.title}\n${value.revisions.map((revision) => `${revision.kind} ${revision.path}: ${revision.before ?? "∅"} → ${revision.after ?? "∅"}`).join("\n")}\n撤销令牌: ${value.undo.token}` });

export const RULE_WITNESS_CAPABILITIES: readonly Capability[] = [functionDiffPlotCapability, subspaceRowTraceCapability, dsPointerStepCapability];
export const EXTENDED_CAPABILITIES: readonly Capability[] = [...RULE_WITNESS_CAPABILITIES, proposalDiffCapability];
