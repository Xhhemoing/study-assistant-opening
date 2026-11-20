import { z } from "zod";
import {
  evaluateProbeWithSpec,
  keepGroundedSeeds,
  respectActiveRetestWindows,
  sortTaskCandidates,
} from "./capability-helpers";
import type { CartridgeObservationEmission } from "./evidence-gate";
import type { DistinguishableProbeSpec, MisconceptionHypothesis } from "./probe-protocol";
import { restoreContinuityState } from "./types";
import type {
  CartridgeChunkBinding,
  CartridgeExerciseSeed,
  CartridgeMaterialChunk,
  CartridgeProbeEvaluation,
  CartridgeResumeSummary,
  CartridgeScheduleInput,
  CartridgeTaskCandidate,
  CartridgeValidationResult,
  EvidenceCartridge,
} from "./types";

/**
 * 408.stack.v1 — deterministic CS 408 data-structures stack reference cartridge (L4).
 * Convention under test: `top` starts at -1, push is `data[++top] = x`, pop is `x = data[top--]`.
 */
export const STACK_408_CARTRIDGE_ID = "408.stack.v1";
export const STACK_408_CARTRIDGE_VERSION = "1.0.0";

export const STACK_408_REQUIREMENTS = [
  "408.ds.stack.lifo-trace",
  "408.ds.stack.pointer-convention",
  "408.ds.stack.pop-sequence-feasibility",
] as const;
export type Stack408RequirementKey = (typeof STACK_408_REQUIREMENTS)[number];

/* ----------------------------------------------------------- trace model -- */

export type StackOp = { op: "push"; value: number } | { op: "pop" };
export interface StackTraceInput { capacity: number; ops: readonly StackOp[] }
/** Pop outputs in order; tokens are integers, `UNDERFLOW`, `OVERFLOW` or `UNINITIALIZED`. */
export interface StackTraceObservable { outputs: string[]; finalTop: number }

const UNDERFLOW = "UNDERFLOW";
const OVERFLOW = "OVERFLOW";
const UNINITIALIZED = "UNINITIALIZED";

function readSlot(data: ReadonlyMap<number, number>, index: number): string {
  const value = data.get(index);
  return value === undefined ? UNINITIALIZED : String(value);
}

/** M*: correct sequential stack with `data[++top] = x` / `x = data[top--]`. */
export function simulateCorrectStackTrace(input: StackTraceInput): StackTraceObservable {
  const data = new Map<number, number>();
  const outputs: string[] = [];
  let top = -1;
  for (const op of input.ops) {
    if (op.op === "push") {
      if (top >= input.capacity - 1) { outputs.push(OVERFLOW); continue; }
      top += 1;
      data.set(top, op.value);
    } else {
      if (top === -1) { outputs.push(UNDERFLOW); continue; }
      outputs.push(readSlot(data, top));
      top -= 1;
    }
  }
  return { outputs, finalTop: top };
}

/** H_FIFO_QUEUE_CONFUSION: pop removes the oldest element, as in a queue. */
export function simulateFifoQueueConfusionTrace(input: StackTraceInput): StackTraceObservable {
  const queue: number[] = [];
  const outputs: string[] = [];
  for (const op of input.ops) {
    if (op.op === "push") {
      if (queue.length >= input.capacity) { outputs.push(OVERFLOW); continue; }
      queue.push(op.value);
    } else {
      const head = queue.shift();
      outputs.push(head === undefined ? UNDERFLOW : String(head));
    }
  }
  return { outputs, finalTop: queue.length - 1 };
}

/** H_TOP_POINTER_OFF_BY_ONE: writes `data[top++] = x` while keeping the `top = -1` convention. */
export function simulateTopPointerOffByOneTrace(input: StackTraceInput): StackTraceObservable {
  const data = new Map<number, number>();
  const outputs: string[] = [];
  let top = -1;
  for (const op of input.ops) {
    if (op.op === "push") {
      if (top >= input.capacity - 1) { outputs.push(OVERFLOW); continue; }
      data.set(top, op.value);
      top += 1;
    } else {
      if (top === -1) { outputs.push(UNDERFLOW); continue; }
      outputs.push(readSlot(data, top));
      top -= 1;
    }
  }
  return { outputs, finalTop: top };
}

/* ----------------------------------------------------- feasibility model -- */

export interface StackFeasibilityInput { pushOrder: readonly number[]; candidatePops: readonly number[] }
export interface StackFeasibilityObservable { verdict: "feasible" | "infeasible"; firstViolationIndex: number | null }

const feasible = (): StackFeasibilityObservable => ({ verdict: "feasible", firstViolationIndex: null });
const infeasibleAt = (index: number): StackFeasibilityObservable => ({ verdict: "infeasible", firstViolationIndex: index });

/** Index of the first pop that exceeds the remaining multiplicity of that value in pushOrder. */
function firstMembershipViolation(input: StackFeasibilityInput): number | null {
  const available = new Map<number, number>();
  for (const value of input.pushOrder) available.set(value, (available.get(value) ?? 0) + 1);
  for (let i = 0; i < input.candidatePops.length; i += 1) {
    const value = input.candidatePops[i]!;
    const remaining = available.get(value) ?? 0;
    if (remaining === 0) return i;
    available.set(value, remaining - 1);
  }
  return null;
}

function simulateStackFeasibility(
  input: StackFeasibilityInput,
  peekIndex: (length: number) => number,
): StackFeasibilityObservable {
  const { pushOrder, candidatePops } = input;
  if (candidatePops.length === 0) return feasible();
  const membership = firstMembershipViolation(input);
  const limit = membership === null ? candidatePops.length : membership;
  const suffixCounts: Array<Map<number, number>> = new Array(pushOrder.length + 1);
  suffixCounts[pushOrder.length] = new Map();
  for (let i = pushOrder.length - 1; i >= 0; i -= 1) {
    const nextMap = new Map(suffixCounts[i + 1]);
    const value = pushOrder[i]!;
    nextMap.set(value, (nextMap.get(value) ?? 0) + 1);
    suffixCounts[i] = nextMap;
  }

  let maxMatched = 0;
  const visited = new Set<string>();
  const search = (next: number, outIdx: number, stack: readonly number[]): boolean => {
    if (outIdx > maxMatched) maxMatched = outIdx;
    if (outIdx === limit) return true;
    const target = candidatePops[outIdx]!;
    let curNext = next;
    const curStack = [...stack];
    while (curNext < pushOrder.length) {
      const idx = peekIndex(curStack.length);
      if (idx >= 0 && idx < curStack.length && curStack[idx] === target) break;
      curStack.push(pushOrder[curNext]!);
      curNext += 1;
    }
    const idx = peekIndex(curStack.length);
    if (idx < 0 || idx >= curStack.length || curStack[idx] !== target) return false;
    const stateKey = `${curNext}|${outIdx}|${curStack.join(",")}`;
    if (visited.has(stateKey)) return false;
    visited.add(stateKey);

    const afterPop = [...curStack.slice(0, idx), ...curStack.slice(idx + 1)];
    if (search(curNext, outIdx + 1, afterPop)) return true;

    // Duplicate-symbol backtracking: when another copy of `target` still lies ahead in
    // pushOrder, pushing past the current match can preserve a feasible stack order.
    if (curNext < pushOrder.length && (suffixCounts[curNext]!.get(target) ?? 0) > 0) {
      if (search(curNext + 1, outIdx, [...curStack, pushOrder[curNext]!])) return true;
    }
    return false;
  };

  const reachedLimit = search(0, 0, []);
  if (reachedLimit && membership === null) return feasible();
  return infeasibleAt(maxMatched);
}

/** M*: exact LIFO simulation of the candidate pop sequence (supports repeated symbols). */
export function simulateCorrectFeasibility(input: StackFeasibilityInput): StackFeasibilityObservable {
  return simulateStackFeasibility(input, length => length - 1);
}

/** H_FIFO_QUEUE_CONFUSION: only the push order itself is accepted. */
export function simulateFifoQueueConfusionFeasibility(input: StackFeasibilityInput): StackFeasibilityObservable {
  const membership = firstMembershipViolation(input);
  for (let i = 0; i < input.candidatePops.length; i += 1) {
    if (membership === i || input.candidatePops[i] !== input.pushOrder[i]) return infeasibleAt(i);
  }
  return feasible();
}

/** H_TOP_POINTER_OFF_BY_ONE: reads the element at `top - 1` as the current stack top. */
export function simulateTopPointerOffByOneFeasibility(input: StackFeasibilityInput): StackFeasibilityObservable {
  return simulateStackFeasibility(input, length => length - 2);
}

/** H_BYPASS_LIFO_ORDER: believes any element already pushed may be popped, so every permutation works. */
export function simulateBypassLifoFeasibility(input: StackFeasibilityInput): StackFeasibilityObservable {
  const membership = firstMembershipViolation(input);
  return membership === null ? feasible() : infeasibleAt(membership);
}

/** All unique pop orders reachable from `pushOrder` by a correct stack (Catalan-many for distinct values). */
export function enumerateFeasiblePopSequences(pushOrder: readonly number[]): number[][] {
  const results: number[][] = [];
  const seen = new Set<string>();
  const walk = (next: number, stack: number[], output: number[]) => {
    if (output.length === pushOrder.length) {
      const key = output.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        results.push([...output]);
      }
      return;
    }
    if (stack.length) {
      const value = stack[stack.length - 1]!;
      walk(next, stack.slice(0, -1), [...output, value]);
    }
    if (next < pushOrder.length) walk(next + 1, [...stack, pushOrder[next]!], output);
  };
  walk(0, [], []);
  return results.sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

/* ---------------------------------------------------------------- probes -- */

const traceKey = (observable: StackTraceObservable) => JSON.stringify(["trace", observable.outputs, observable.finalTop]);
const feasibilityKey = (observable: StackFeasibilityObservable) =>
  JSON.stringify(["feasibility", observable.verdict, observable.firstViolationIndex]);

const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  UNDERFLOW, 下溢: UNDERFLOW, 栈空: UNDERFLOW,
  OVERFLOW, 上溢: OVERFLOW, 栈满: OVERFLOW,
  UNINITIALIZED, GARBAGE: UNINITIALIZED, 未初始化: UNINITIALIZED,
};

function normalizeTraceToken(token: unknown): string | null {
  if (typeof token === "number") return Number.isSafeInteger(token) ? String(token) : null;
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  if (/^[+-]?\d+$/.test(trimmed)) return BigInt(trimmed).toString();
  const alias = trimmed.toUpperCase();
  return Object.hasOwn(TOKEN_ALIASES, alias) ? TOKEN_ALIASES[alias]! : null;
}

export function parseStackTraceResponse(response: unknown): StackTraceObservable | null {
  if (!response || typeof response !== "object") return null;
  const { outputs, finalTop } = response as { outputs?: unknown; finalTop?: unknown };
  const raw = typeof outputs === "string" ? (outputs.trim() ? outputs.split(/[,，\s]+/).filter(Boolean) : []) : outputs;
  if (!Array.isArray(raw) || typeof finalTop !== "number" || !Number.isInteger(finalTop) || finalTop < -1) return null;
  const tokens: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.hasOwn(raw, index)) return null;
    const token = normalizeTraceToken(raw[index]);
    if (token === null) return null;
    tokens.push(token);
  }
  return { outputs: tokens, finalTop };
}

function feasibilityParser(input: StackFeasibilityInput) {
  return (response: unknown): StackFeasibilityObservable | null => {
    if (!response || typeof response !== "object") return null;
    const { verdict, firstViolationIndex } = response as { verdict?: unknown; firstViolationIndex?: unknown };
    if (verdict === "feasible") return firstViolationIndex == null ? feasible() : null;
    if (verdict !== "infeasible" || typeof firstViolationIndex !== "number" || !Number.isInteger(firstViolationIndex)
      || firstViolationIndex < 0 || firstViolationIndex >= input.candidatePops.length) return null;
    return infeasibleAt(firstViolationIndex);
  };
}

const H_FIFO_QUEUE_CONFUSION = "H_FIFO_QUEUE_CONFUSION";
const H_TOP_POINTER_OFF_BY_ONE = "H_TOP_POINTER_OFF_BY_ONE";
const H_BYPASS_LIFO_ORDER = "H_BYPASS_LIFO_ORDER";
export const STACK_408_HYPOTHESIS_IDS = [H_FIFO_QUEUE_CONFUSION, H_TOP_POINTER_OFF_BY_ONE, H_BYPASS_LIFO_ORDER] as const;

const fifoDescription = "把栈当作队列：出栈取最早入栈的元素。";
const offByOneDescription = "栈顶指针顺序混淆：在 top 初值为 -1 时使用 data[top++] = x。";
const bypassDescription = "绕过后进先出约束：认为任意已入栈元素都可直接出栈，因此任何排列都是合法出栈序列。";

export const stackTraceHypotheses: readonly MisconceptionHypothesis<StackTraceInput, StackTraceObservable>[] = [
  { id: H_FIFO_QUEUE_CONFUSION, role: "misconception", label: "队列混淆", description: fifoDescription,
    predict: simulateFifoQueueConfusionTrace },
  { id: H_TOP_POINTER_OFF_BY_ONE, role: "misconception", label: "top++ / ++top 混淆", description: offByOneDescription,
    predict: simulateTopPointerOffByOneTrace },
];

export const stackFeasibilityHypotheses: readonly MisconceptionHypothesis<StackFeasibilityInput, StackFeasibilityObservable>[] = [
  { id: H_FIFO_QUEUE_CONFUSION, role: "misconception", label: "队列混淆", description: fifoDescription,
    predict: simulateFifoQueueConfusionFeasibility },
  { id: H_TOP_POINTER_OFF_BY_ONE, role: "misconception", label: "栈顶读取错位", description: offByOneDescription,
    predict: simulateTopPointerOffByOneFeasibility },
  { id: H_BYPASS_LIFO_ORDER, role: "misconception", label: "绕过 LIFO", description: bypassDescription,
    predict: simulateBypassLifoFeasibility },
];

export function createStackTraceProbe(
  probeId: string,
  requirementKey: Stack408RequirementKey,
  input: StackTraceInput,
  prompt: string,
): DistinguishableProbeSpec<StackTraceInput, StackTraceObservable> {
  return { probeId, requirementKey, prompt, input,
    correctModel: { id: "M_CORRECT_LIFO", role: "correct", label: "正确 LIFO 栈", predict: simulateCorrectStackTrace },
    hypotheses: stackTraceHypotheses, observableKey: traceKey, parseResponse: parseStackTraceResponse };
}

export function createStackFeasibilityProbe(
  probeId: string,
  input: StackFeasibilityInput,
  prompt: string,
): DistinguishableProbeSpec<StackFeasibilityInput, StackFeasibilityObservable> {
  return { probeId, requirementKey: "408.ds.stack.pop-sequence-feasibility", prompt, input,
    correctModel: { id: "M_CORRECT_LIFO", role: "correct", label: "正确 LIFO 栈", predict: simulateCorrectFeasibility },
    hypotheses: stackFeasibilityHypotheses, observableKey: feasibilityKey, parseResponse: feasibilityParser(input) };
}

const push = (value: number): StackOp => ({ op: "push", value });
const pop: StackOp = { op: "pop" };

const STACK_408_PROBES: readonly DistinguishableProbeSpec<unknown, unknown>[] = [
  createStackTraceProbe("408.stack.trace.interleaved-underflow.v1", "408.ds.stack.lifo-trace",
    { capacity: 4, ops: [push(1), push(2), pop, push(3), pop, pop, pop] },
    "容量为 4 的顺序栈（top 初值 -1）依次执行 push 1, push 2, pop, push 3, pop, pop, pop。写出每次 pop 的结果（空栈写 UNDERFLOW）以及最终 top 值。"),
  createStackTraceProbe("408.stack.pointer.pre-increment.v1", "408.ds.stack.pointer-convention",
    { capacity: 3, ops: [push(5), push(7), push(9), push(11), pop] },
    "容量为 3 的顺序栈，top 初值 -1，入栈 data[++top] = x，出栈 x = data[top--]。依次执行 push 5, push 7, push 9, push 11, pop。写出输出序列（栈满写 OVERFLOW）以及最终 top 值。"),
  createStackFeasibilityProbe("408.stack.pop-sequence.catalan-invalid.v1",
    { pushOrder: [1, 2, 3, 4], candidatePops: [2, 4, 1, 3] },
    "入栈顺序为 1, 2, 3, 4（可随时出栈）。判断出栈序列 2, 4, 1, 3 是否可行；若不可行，给出第一个无法完成的出栈位置（从 0 开始）。"),
];

/* ----------------------------------------------------------------- state -- */

const probeHistoryEntrySchema = z.object({
  probeId: z.string().min(1),
  requirementKey: z.enum(STACK_408_REQUIREMENTS),
  outcome: z.enum(["correct", "incorrect", "unverified"]),
  diagnosis: z.enum(["correct_model", "misconception", "unclassified", "invalid_response"]),
  matchedHypothesisId: z.string().nullable(),
  at: z.iso.datetime(),
}).strict().superRefine((entry, ctx) => {
  const probe = STACK_408_PROBES.find(probe => probe.probeId === entry.probeId);
  if (!probe || probe.requirementKey !== entry.requirementKey) {
    ctx.addIssue({ code: "custom", message: `probe ${entry.probeId} does not belong to ${entry.requirementKey}` });
    return;
  }
  const { outcome, diagnosis, matchedHypothesisId } = entry;
  // An unclassified attempt may have a well-formed unmatched response or no verified result.
  const expectedOutcome = { correct_model: "correct", misconception: "incorrect", invalid_response: "unverified" } as const;
  const outcomeMatches = diagnosis === "unclassified" ? outcome !== "correct" : outcome === expectedOutcome[diagnosis];
  const hypothesisMatches = diagnosis === "misconception"
    ? probe.hypotheses.some(hypothesis => hypothesis.role === "misconception" && hypothesis.id === matchedHypothesisId)
    : matchedHypothesisId === null;
  if (!outcomeMatches || !hypothesisMatches) {
    ctx.addIssue({ code: "custom", message: "outcome, diagnosis, and matchedHypothesisId are inconsistent" });
  }
});

export const stack408StateSchema = z.object({
  schemaVersion: z.literal(1),
  cartridgeId: z.literal(STACK_408_CARTRIDGE_ID),
  currentRequirementKey: z.enum(STACK_408_REQUIREMENTS).nullable(),
  probeHistory: z.array(probeHistoryEntrySchema).max(500),
}).strict();
export type Stack408State = z.infer<typeof stack408StateSchema>;

export function createInitialStack408State(): Stack408State {
  return { schemaVersion: 1, cartridgeId: STACK_408_CARTRIDGE_ID, currentRequirementKey: STACK_408_REQUIREMENTS[0], probeHistory: [] };
}

/** Append a deterministic probe evaluation to continuity state; host supplies the timestamp. */
export function recordStack408ProbeAttempt(state: Stack408State, evaluation: CartridgeProbeEvaluation, at: string): Stack408State {
  const requirementKey = STACK_408_REQUIREMENTS.find(key => key === evaluation.requirementKey);
  if (!requirementKey) return state;
  const probeHistory = [...state.probeHistory, { probeId: evaluation.probeId, requirementKey, outcome: evaluation.outcome,
    diagnosis: evaluation.diagnosis, matchedHypothesisId: evaluation.matchedHypothesisId, at }].slice(-500);
  const next = { ...state, probeHistory };
  return { ...next, currentRequirementKey: nextPendingRequirement(next) };
}

function latestAttempt(state: Stack408State, requirementKey: Stack408RequirementKey) {
  let latest: Stack408State["probeHistory"][number] | null = null;
  for (const entry of state.probeHistory) {
    if (entry.requirementKey !== requirementKey) continue;
    if (!latest || Date.parse(entry.at) >= Date.parse(latest.at)) latest = entry;
  }
  return latest;
}

function nextPendingRequirement(state: Stack408State): Stack408RequirementKey | null {
  return STACK_408_REQUIREMENTS.find(key => latestAttempt(state, key)?.outcome !== "correct") ?? null;
}

function parseState(raw: unknown): CartridgeValidationResult<Stack408State> {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return { ok: false, issues: ["state_not_json"] }; }
  }
  const parsed = stack408StateSchema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`) };
  return { ok: true, value: parsed.data };
}

/* -------------------------------------------------------------- material -- */

const STACK_ANCHORS = ["栈", "stack"];
const REQUIREMENT_TERMS: Readonly<Record<Stack408RequirementKey, readonly string[]>> = {
  "408.ds.stack.lifo-trace": ["后进先出", "lifo", "入栈", "出栈", "push", "pop"],
  "408.ds.stack.pointer-convention": ["栈顶指针", "top++", "++top", "top--", "--top", "栈满", "栈空", "上溢", "下溢", "overflow", "underflow"],
  "408.ds.stack.pop-sequence-feasibility": ["出栈序列", "入栈序列", "进栈序列", "pop sequence", "push sequence", "卡特兰", "catalan"],
};

function bindChunks(chunks: readonly CartridgeMaterialChunk[]): CartridgeChunkBinding[] {
  const bindings: CartridgeChunkBinding[] = [];
  for (const chunk of chunks) {
    const text = chunk.text.toLowerCase();
    if (!STACK_ANCHORS.some(anchor => text.includes(anchor))) continue;
    for (const requirementKey of STACK_408_REQUIREMENTS) {
      const matchedTerms = [...new Set(REQUIREMENT_TERMS[requirementKey].filter(term => text.includes(term)))].sort();
      if (matchedTerms.length) {
        bindings.push({ requirementKey, sourceId: chunk.sourceId, sourceVersion: chunk.sourceVersion,
          chunkId: chunk.chunkId, page: chunk.page, matchedTerms });
      }
    }
  }
  return bindings.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.sourceVersion - b.sourceVersion
    || a.chunkId.localeCompare(b.chunkId) || a.requirementKey.localeCompare(b.requirementKey));
}

const PUSH_ORDER_PATTERN = /(?:入栈序列|进栈序列|入栈顺序|push (?:order|sequence))\s*(?:为|是|is|:|：)?\s*((?:\d+\s*[,，、]\s*){2,7}\d+)/gi;
const OP_TOKEN = String.raw`(?:push\s*\(\s*-?\d+\s*\)|push\s+-?\d+|入栈\s*-?\d+|pop\s*\(\s*\)|pop|出栈)`;
const OP_SEQUENCE_PATTERN = new RegExp(String.raw`${OP_TOKEN}(?:\s*[,，;；、]\s*${OP_TOKEN}){2,15}`, "gi");

function parseOps(quote: string): StackOp[] {
  const ops: StackOp[] = [];
  for (const match of quote.matchAll(new RegExp(OP_TOKEN, "gi"))) {
    const value = /-?\d+/.exec(match[0]);
    ops.push(value ? { op: "push", value: Number(value[0]) } : { op: "pop" });
  }
  return ops;
}

function extractSeeds(
  chunks: readonly CartridgeMaterialChunk[],
  bindings: readonly CartridgeChunkBinding[],
): CartridgeExerciseSeed[] {
  const seeds: CartridgeExerciseSeed[] = [];
  const bound = (chunk: CartridgeMaterialChunk, key: Stack408RequirementKey) => bindings.some(binding =>
    binding.requirementKey === key && binding.sourceId === chunk.sourceId
    && binding.sourceVersion === chunk.sourceVersion && binding.chunkId === chunk.chunkId);
  for (const chunk of chunks) {
    const citationBase = { sourceId: chunk.sourceId, sourceVersion: chunk.sourceVersion, chunkId: chunk.chunkId, page: chunk.page };
    const seedBase = `${STACK_408_CARTRIDGE_ID}:${chunk.sourceId}@${chunk.sourceVersion}#${chunk.chunkId}`;
    if (bound(chunk, "408.ds.stack.pop-sequence-feasibility")) {
      for (const match of chunk.text.matchAll(PUSH_ORDER_PATTERN)) {
        const order = match[1]!.split(/[,，、]/).map(part => Number(part.trim()));
        if (new Set(order).size !== order.length) continue;
        const pushOrder = order.join(",");
        seeds.push({ seedId: `${seedBase}:feasibility:${match.index}`, requirementKey: "408.ds.stack.pop-sequence-feasibility",
          prompt: `入栈顺序为 ${order.join(", ")}（可随时出栈）。给定一个出栈序列，判断其是否可行；若不可行，指出第一个无法完成的出栈位置。`,
          citation: { ...citationBase, quote: match[0] }, parameters: { pushOrder } });
      }
    }
    if (bound(chunk, "408.ds.stack.lifo-trace")) {
      for (const match of chunk.text.matchAll(OP_SEQUENCE_PATTERN)) {
        const ops = parseOps(match[0]);
        if (!ops.some(op => op.op === "push") || !ops.some(op => op.op === "pop")) continue;
        const rendered = ops.map(op => op.op === "push" ? `push ${op.value}` : "pop").join(", ");
        seeds.push({ seedId: `${seedBase}:trace:${match.index}`, requirementKey: "408.ds.stack.lifo-trace",
          prompt: `空栈（top 初值 -1）依次执行 ${rendered}。写出每次 pop 的结果以及最终 top 值。`,
          citation: { ...citationBase, quote: match[0] }, parameters: { ops: rendered } });
      }
    }
  }
  return keepGroundedSeeds(seeds, chunks).sort((a, b) => a.seedId.localeCompare(b.seedId));
}

/* -------------------------------------------------------------- schedule -- */

const DAY_MS = 86_400_000;

function projectCandidates(input: CartridgeScheduleInput<Stack408State>): CartridgeTaskCandidate[] {
  const nowMs = Date.parse(input.now);
  const candidates = STACK_408_REQUIREMENTS.map((requirementKey, index): CartridgeTaskCandidate => {
    const latest = latestAttempt(input.state, requirementKey);
    const order = index * 10;
    const make = (kind: CartridgeTaskCandidate["kind"], cadenceDays: number, earliestMs: number, priority: number) => ({
      candidateId: `${STACK_408_CARTRIDGE_ID}:${requirementKey}:${kind}`, requirementKey, kind, cadenceDays,
      earliestAt: new Date(earliestMs).toISOString(), priority });
    if (!latest) return make("learn", 0, nowMs, 100 - order);
    if (latest.outcome === "correct") return make("review", 3, Date.parse(latest.at) + 3 * DAY_MS, 50 - order);
    return make("practice", 1, nowMs, (latest.diagnosis === "misconception" ? 150 : 120) - order);
  });
  const limit = Math.max(1, Math.min(20, input.limit ?? 5));
  return sortTaskCandidates(respectActiveRetestWindows(candidates, input.activeRetestWindows, input.now)).slice(0, limit);
}

/* -------------------------------------------------------------- cartridge -- */

function resumeSummary(raw: unknown): CartridgeResumeSummary {
  const state = restoreContinuityState(parseState, raw);
  const completed = STACK_408_REQUIREMENTS.filter(key => latestAttempt(state, key)?.outcome === "correct").length;
  const next = nextPendingRequirement(state);
  return { cartridgeId: STACK_408_CARTRIDGE_ID, cartridgeVersion: STACK_408_CARTRIDGE_VERSION,
    headline: next ? `栈：已完成 ${completed}/${STACK_408_REQUIREMENTS.length} 个检查点，继续 ${next}` : "栈：全部检查点已完成，可进入复习",
    completedSteps: completed, totalSteps: STACK_408_REQUIREMENTS.length, nextRequirementKey: next };
}

export const stack408Cartridge: EvidenceCartridge<Stack408State> = {
  manifest: { id: STACK_408_CARTRIDGE_ID, version: STACK_408_CARTRIDGE_VERSION, domain: "cs408.data-structures",
    title: "408 数据结构：栈的状态追踪", level: "L4_EVIDENCE" },
  evidenceContract: { evaluatorVersion: "stack-trace-exact-v1", specVersion: "408-stack-v1" },
  serializeContinuityState(state) {
    return JSON.stringify(stack408StateSchema.parse(state));
  },
  parseContinuityState: parseState,
  buildResumeSummary: resumeSummary,
  projectTaskCandidates: projectCandidates,
  bindMaterialChunks: bindChunks,
  extractExerciseSeeds: extractSeeds,
  listProbes() {
    return STACK_408_PROBES;
  },
  getProbe(probeId) {
    return STACK_408_PROBES.find(probe => probe.probeId === probeId) ?? null;
  },
  evaluateProbeResponse(probeId, response) {
    const probe = STACK_408_PROBES.find(row => row.probeId === probeId);
    if (!probe) {
      return { probeId, requirementKey: "", outcome: "unverified", diagnosis: "invalid_response", matchedHypothesisId: null, observableKey: null };
    }
    return evaluateProbeWithSpec(probe, response);
  },
};

/** Evidence mapping: the raw response is the only learner-controlled field. */
export function toStack408Emission(probeId: string, response: unknown): CartridgeObservationEmission {
  return { cartridgeId: STACK_408_CARTRIDGE_ID, cartridgeVersion: STACK_408_CARTRIDGE_VERSION, probeId, response };
}
