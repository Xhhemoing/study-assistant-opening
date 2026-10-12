/**
 * Deterministic rule planner: lifts structure the answer already states (an arrow
 * chain, a numeric table) into checked blocks. It never invents data and never
 * interprets meaning; a model planner can replace it behind the same output shape.
 */
import { artifactSchema, type Artifact, type ArtifactBlock } from "../artifact";
import { COMPARISON_BARS_ID, type ComparisonBarsParams } from "../capabilities/comparison-bars";
import { FLOW_DIAGRAM_ID, type FlowDiagramParams } from "../capabilities/flow-diagram";

export type RulePlanInput = {
  /** The reader's request; used only for explicit text-only wishes. */
  question?: string;
  answer: string;
  artifactId: string;
};

export type RulePlan = { artifact: Artifact | null; reason: string };

const TEXT_ONLY = /不要图|不用图|不画图|别画图|只要文字|只用文字|仅文字|纯文字|纯文本|一句话|text[ -]only|no (?:chart|diagram)s?/i;
// Only step arrows: `=>` is code and `⇒` is implication, neither is "then".
const ARROW = /\s*(?:->|→|⟶)\s*/;
const CJK = /[㐀-鿿]/;
const MAX_ANSWER = 50_000;

function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*(?:[-*+]|\d+[.)、])\s+/, "")
    .trim();
}

/** Lines outside fenced code blocks; arrows or pipes inside code are not prose structure. */
function proseLines(answer: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const line of answer.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) lines.push(line);
  }
  return lines;
}

export function extractFlow(lines: readonly string[]): FlowDiagramParams | null {
  for (const raw of lines) {
    if (raw.split(ARROW).length < 3) continue;
    // "流程：A → B → C" — drop a lead-in label before the first step.
    const body = stripMarkdown(raw).replace(/^[^：:→>]{1,12}[：:]\s*/, "");
    const labels = body.split(ARROW).map((part) => part.replace(/[。．.；;，,]+$/, "").trim());
    if (labels.length < 3 || labels.length > 8) continue;
    const valid =
      labels.every((label) => label.length >= 1 && label.length <= 24 && (CJK.test(label) || label.length > 2)) &&
      new Set(labels).size === labels.length;
    if (!valid) continue;
    const nodes = labels.map((label, i) => ({ id: `s${i + 1}`, label }));
    const edges = nodes.slice(1).map((node, i) => ({ from: nodes[i]!.id, to: node.id, relation: "sequence" as const }));
    return { nodes, edges };
  }
  return null;
}

const NUMERIC_CELL = /^([+-]?\d+(?:\.\d+)?)\s*(%|[A-Za-z㐀-鿿]{1,4})?$/;
const HEADER_UNIT = /[（(]\s*([^（）()]{1,8})\s*[）)]\s*$/;
/** A column that is only a time axis (年份/日期…); durations like “投入时间” are measures. */
const TIME_HEADER = /^(?:年|年份|年度|日期|时间|时间点|year|date|time)$/i;

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => stripMarkdown(cell));
}

function parseNumericColumn(cells: string[]): { values: number[]; unit?: string } | null {
  let unit: string | undefined;
  const values: number[] = [];
  for (const cell of cells) {
    const match = NUMERIC_CELL.exec(cell.replace(/,/g, ""));
    if (!match) return null;
    const cellUnit = match[2];
    if (values.length > 0 && cellUnit !== unit) return null;
    unit = cellUnit;
    values.push(Number(match[1]));
  }
  return { values, unit };
}

export function extractComparison(lines: readonly string[]): ComparisonBarsParams | null {
  for (let i = 0; i + 3 < lines.length; i++) {
    const header = splitRow(lines[i]!);
    const delimiter = splitRow(lines[i + 1]!);
    if (!header || !delimiter || header.length < 2 || delimiter.length !== header.length) continue;
    if (!delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const row = splitRow(lines[j]!);
      if (!row || row.length !== header.length) break;
      rows.push(row);
    }
    if (rows.length < 2 || rows.length > 12) continue;
    const labels = rows.map((row) => row[0]!);
    if (labels.some((label) => !label || label.length > 40) || new Set(labels).size !== labels.length) continue;
    for (let col = 1; col < header.length; col++) {
      const measureHeader = header[col]!;
      const measure = measureHeader.replace(HEADER_UNIT, "").trim() || "数值";
      if (TIME_HEADER.test(measure)) continue;
      const column = parseNumericColumn(rows.map((row) => row[col]!));
      if (!column || column.values.some((value) => value < 0)) continue;
      const headerUnit = HEADER_UNIT.exec(measureHeader)?.[1]?.trim();
      return {
        measure,
        ...((column.unit ?? headerUnit) ? { unit: column.unit ?? headerUnit } : {}),
        bars: labels.map((label, k) => ({ label, value: column.values[k]! })),
      };
    }
  }
  return null;
}

function block(id: string, capability: string, params: unknown, limits: string[]): ArtifactBlock {
  return { id, capability, params, allowedActions: [], limits, sourceRefs: [] };
}

export function planFromRules({ question, answer, artifactId }: RulePlanInput): RulePlan {
  if (question && TEXT_ONLY.test(question)) return { artifact: null, reason: "遵从只要文字的要求" };
  if (!answer.trim() || answer.length > MAX_ANSWER) return { artifact: null, reason: "没有可整理的结构" };

  const lines = proseLines(answer);
  const blocks: ArtifactBlock[] = [];
  const reasons: string[] = [];
  const flow = extractFlow(lines);
  if (flow) {
    blocks.push(block("flow", FLOW_DIAGRAM_ID, flow, ["按回答中写出的顺序整理，不代表已验证的因果关系"]));
    reasons.push("回答写出了步骤顺序");
  }
  const comparison = extractComparison(lines);
  if (comparison) {
    blocks.push(block("comparison", COMPARISON_BARS_ID, comparison, ["数值取自回答中的表格，未经外部核实"]));
    reasons.push("回答给出了同一列的数值");
  }
  if (!blocks.length) return { artifact: null, reason: "没有可整理的结构，保持文字" };

  const artifact = artifactSchema.parse({
    schemaVersion: "1",
    artifactId,
    revision: 1,
    provenance: { origin: "rules", note: "从回答文本中确定性提取" },
    blocks,
  });
  return { artifact, reason: reasons.join("；") };
}
