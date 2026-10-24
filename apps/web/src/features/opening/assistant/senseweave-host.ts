/** Local-only SenseWeave host. Completed answers only, explicit feedback and account-scoped persistence. */
import { createHostAdapter, TEACHING_PRESETS, type HostAdapter, type PreparedAnswer, type TeachingPresetName } from "@aistudy/senseweave/host";
import { SENSEWEAVE_INITIAL_GATES, type SenseWeaveGates } from "@aistudy/config/public";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";

export type SenseWeaveMode = "off" | "shadow" | "on";
const PREFS_KEY = "aistudy.senseweave.preferences.v2";
export const SENSEWEAVE_TOKENS = {
  accent: "var(--color-accent)", ink: "var(--color-text)", muted: "var(--color-text-2)",
  line: "var(--color-line)", paper: "var(--color-surface)", soft: "var(--color-surface-2)", font: "inherit",
} as const;
export const SENSEWEAVE_MIN_CHARS = 120;
type Preferences = Record<string, { positive: number; negative: number }>;

function readPreferences(key: string | null): Preferences | undefined {
  if (!key || typeof window === "undefined") return undefined;
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) as Preferences : undefined; }
  catch { return undefined; }
}
function writePreferences(key: string | null, snapshot: Preferences) {
  if (!key || typeof window === "undefined") return;
  try { window.localStorage.setItem(key, JSON.stringify(snapshot)); }
  catch { /* Storage denial only loses cross-reload persistence; feedback still applies in memory. */ }
}
const gatePreset = (name: TeachingPresetName): keyof SenseWeaveGates["presets"] => name === "compare" || name === "derive" ? "explain" : name;
export function senseWeaveComponents(name: TeachingPresetName, gates: SenseWeaveGates) {
  const allowed = gates.presets[gatePreset(name)];
  // Runtime teaching presets are a hard ceiling; host gates can only remove components.
  return (TEACHING_PRESETS[name].capabilities.components ?? []).filter(type => allowed.some(value => value === type));
}
let owner: string | null | undefined;
const adapters = new Map<string, HostAdapter>();
export function senseWeaveAdapter(preset: TeachingPresetName = "explain", gates: SenseWeaveGates = SENSEWEAVE_INITIAL_GATES): HostAdapter {
  const namespace = getVerifiedSessionNamespace();
  if (owner !== namespace) { adapters.clear(); owner = namespace; }
  const components = senseWeaveComponents(preset, gates);
  const identity = JSON.stringify([preset, gates.version, components]);
  const create = () => {
    // Never adopt unowned v1 data from a previous login. Late callbacks keep their captured owner.
    const key = namespace ? `${PREFS_KEY}:${encodeURIComponent(namespace)}:${preset}` : null;
    return createHostAdapter({ preset, minChars: SENSEWEAVE_MIN_CHARS,
      options: { capabilities: { components } },
      preferences: { initial: readPreferences(key), onChange: snapshot => writePreferences(key, snapshot) },
    });
  };
  // SSR is stateless: no process-wide cache of another user's answer or preferences.
  if (typeof window === "undefined") return create();
  const found = adapters.get(identity);
  if (found) return found;
  if (adapters.size >= 14) adapters.delete(adapters.keys().next().value!);
  const result = create(); adapters.set(identity, result); return result;
}

export function senseWeavePreset(question: string | undefined): TeachingPresetName {
  const q = question ?? "";
  if (/提示|思路|别(直接)?(告诉|给)我?答案|不要(直接)?(给|说)答案|点拨/.test(q)) return "hint";
  if (/错题|错因|哪里错|为什么错|批改|复盘|订正/.test(q)) return "review";
  if (/计划|安排|日程|时间表|复习规划|冲刺/.test(q)) return "plan";
  if (/成绩|分数|正确率|得分|趋势|统计|数据/.test(q)) return "data";
  if (/区别|对比|比较|异同|不同点/.test(q)) return "compare";
  if (/推导|证明|怎么(得|来)的/.test(q)) return "derive";
  return "explain";
}
const owners = new WeakMap<PreparedAnswer, HostAdapter>();
export function prepareSenseWeave(message: { id: string; text: string; mode?: "hint" | "explain" | "listen" | "think_together" }, question: string | undefined, gates: SenseWeaveGates = SENSEWEAVE_INITIAL_GATES, conservativeHint = false): PreparedAnswer {
  const preset = message.mode === "hint" || !message.mode && conservativeHint ? "hint" : senseWeavePreset(question);
  const adapter = senseWeaveAdapter(preset, gates);
  const prepared = adapter.prepare(message.text, { id: message.id, preset, prompt: question });
  owners.set(prepared, adapter);
  return prepared;
}
export function senseWeaveFeedback(prepared: PreparedAnswer, type: string, helpful: boolean) {
  owners.get(prepared)?.feedback({ type, preset: prepared.preset, helpful });
}
export function senseWeaveStats() { return [...adapters.values()].map(adapter => adapter.stats()); }
