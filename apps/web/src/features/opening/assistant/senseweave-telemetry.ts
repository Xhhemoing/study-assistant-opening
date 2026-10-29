import { z } from "zod";
import type { PreparedAnswer } from "@aistudy/senseweave/host";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";

const typeSchema = z.enum(["prose", "callout", "details", "steps", "diagram", "table", "compare", "checklist", "timeline", "chart", "plot", "derivation", "math", "json", "diff", "other"]);
const rejectionSchema = z.enum(["capability", "score", "budget", "overlap", "selector", "other"]);
export const senseWeaveShadowSchema = z.object({
  schemaVersion: z.literal("sw-shadow-v1"),
  policyVersion: z.string().regex(/^[a-zA-Z0-9.-]{1,40}$/),
  featureVersion: z.literal("features-v0"),
  weightVersion: z.literal("weights-v0"),
  gateVersion: z.string().regex(/^sw-gates-[a-z0-9-]{1,64}$/),
  preset: z.enum(["hint", "explain", "review", "plan", "data", "derive", "compare"]),
  lengthBucket: z.enum(["short", "medium", "long", "very-long"]),
  state: z.enum(["text", "enhance", "suggest", "authored"]),
  selected: z.array(z.object({ type: typeSchema, score: z.number().min(0).max(1) }).strict()).max(8),
  rejected: z.array(z.object({ type: typeSchema, score: z.number().min(0).max(1), reason: rejectionSchema }).strict()).max(64),
  rejectedTruncated: z.boolean(),
  fallback: z.boolean(),
}).strict();
export type SenseWeaveShadow = z.infer<typeof senseWeaveShadowSchema>;
const typeOf = (value: string) => typeSchema.safeParse(value).success ? value as z.infer<typeof typeSchema> : "other" as const;
function reasonOf(reasons: string[]): z.infer<typeof rejectionSchema> {
  const last = reasons.at(-1) ?? "";
  if (last === "宿主未启用该组件") return "capability";
  if (last === "净展示收益不足，保持原样") return "score";
  if (last === "展示预算不足") return "budget";
  if (last === "同一内容只选择一种主要呈现，避免重复") return "overlap";
  if (last === "可选语义选择器没有选择此候选") return "selector";
  return "other";
}
/** Strict whitelist projection: never serialize the prepared answer, messages, offsets or diagnostics. */
export function shadowRecord(prepared: PreparedAnswer, length: number, gateVersion: string): SenseWeaveShadow {
  const decision = prepared.decision;
  const rejected = decision?.rejected ?? [];
  return senseWeaveShadowSchema.parse({
    schemaVersion: "sw-shadow-v1", policyVersion: decision?.policyVersion ?? "none",
    featureVersion: "features-v0", weightVersion: "weights-v0", gateVersion, preset: prepared.preset,
    lengthBucket: length < 120 ? "short" : length < 1000 ? "medium" : length < 5000 ? "long" : "very-long",
    state: decision?.state ?? "text",
    selected: (decision?.selected ?? []).slice(0, 8).map(row => ({ type: typeOf(row.type), score: row.score })),
    rejected: rejected.slice(0, 64).map(row => ({ type: typeOf(row.type), score: row.score, reason: reasonOf(row.reasons) })),
    rejectedTruncated: rejected.length > 64, fallback: prepared.error !== null || prepared.diagnostics.length > 0,
  });
}

type BufferState = { namespace: string | null; seen: WeakSet<PreparedAnswer>; keys: Set<string>; records: SenseWeaveShadow[]; revert: number; shown: number; shownSeen: WeakSet<PreparedAnswer>; shownKeys: Set<string>; reverted: WeakMap<PreparedAnswer, Set<string>>; revertKeys: Map<string, Set<string>> };
let buffer: BufferState | undefined;
function state(): BufferState {
  const namespace = getVerifiedSessionNamespace();
  if (!buffer || buffer.namespace !== namespace) buffer = { namespace, seen: new WeakSet(), keys: new Set(), records: [], revert: 0, shown: 0, shownSeen: new WeakSet(), shownKeys: new Set(), reverted: new WeakMap(), revertKeys: new Map() };
  return buffer;
}
/** Local tab buffer only. No fetch, console payload, identity, prompt, raw text, or exact timestamp. */
export function observeSenseWeave(prepared: PreparedAnswer, length: number, gateVersion: string, rendered: boolean, localMessageKey?: string): void {
  if (typeof window === "undefined") return;
  const current = state();
  // Identity is used only in bounded private memory, never in a record/export.
  const alreadySeen = localMessageKey ? current.keys.has(localMessageKey) : current.seen.has(prepared);
  const alreadyShown = localMessageKey ? current.shownKeys.has(localMessageKey) : current.shownSeen.has(prepared);
  current.seen.add(prepared);
  if (rendered) current.shownSeen.add(prepared);
  if (localMessageKey) {
    const reverted = current.revertKeys.get(localMessageKey) ?? new Set<string>();
    current.revertKeys.set(localMessageKey, reverted); current.reverted.set(prepared, reverted);
    if (current.revertKeys.size > 2000) current.revertKeys.delete(current.revertKeys.keys().next().value!);
  }
  if (!alreadySeen) {
    current.records.push(shadowRecord(prepared, length, gateVersion));
    if (current.records.length > 500) current.records.shift();
    if (localMessageKey) { current.keys.add(localMessageKey); if (current.keys.size > 2000) { current.keys.delete(current.keys.values().next().value!); } }
  }
  if (rendered && !alreadyShown) {
    current.shown += prepared.segments.filter(segment => segment.kind === "block").length;
    if (localMessageKey) { current.shownKeys.add(localMessageKey); if (current.shownKeys.size > 2000) current.shownKeys.delete(current.shownKeys.values().next().value!); }
  }
}
export function recordSenseWeaveRevert(prepared: PreparedAnswer, blockId: string): void {
  const current = state();
  if (!current.shownSeen.has(prepared)) return;
  const ids = current.reverted.get(prepared) ?? new Set<string>();
  if (!ids.has(blockId)) { ids.add(blockId); current.revert++; current.reverted.set(prepared, ids); }
}
export function senseWeaveShadowSnapshot() {
  const current = state();
  return { schemaVersion: "sw-shadow-export-v1", records: structuredClone(current.records), metrics: { shownBlocks: current.shown, revertedBlocks: current.revert, revertRate: current.shown ? current.revert / current.shown : null }, scope: "local-tab-only; directional, not a human efficacy result" };
}
