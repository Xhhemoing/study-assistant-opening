/**
 * SenseWeave in chat answers (SW0). The runtime decides locally, with no model call, whether a
 * fragment of a finished answer reads better as a diagram, chart, plot or timeline; everything
 * else stays LearningProse. One adapter per tab keeps explicit feedback and counters together.
 */
import { createHostAdapter, type HostAdapter, type PreparedAnswer, type TeachingPresetName } from "@aistudy/senseweave/host";

export type SenseWeaveMode = "off" | "shadow" | "on";

const PREFS_KEY = "aistudy.senseweave.preferences.v1";

/** Host colours as CSS variables, so light/dark themes follow the app without a second palette. */
export const SENSEWEAVE_TOKENS = {
  accent: "var(--color-accent)",
  ink: "var(--color-text)",
  muted: "var(--color-text-2)",
  line: "var(--color-line)",
  paper: "var(--color-surface)",
  soft: "var(--color-surface-2)",
  font: "inherit",
} as const;

/** Answers shorter than this are a sentence or two: never worth a component. */
export const SENSEWEAVE_MIN_CHARS = 120;

function readPreferences(): Record<string, { positive: number; negative: number }> | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, { positive: number; negative: number }>) : undefined;
  } catch {
    return undefined; // Unreadable storage only loses learned preferences; the store validates entries.
  }
}

function writePreferences(snapshot: Record<string, { positive: number; negative: number }>) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(snapshot));
  } catch {
    // Private mode / quota: feedback still applies for this tab.
  }
}

let adapter: HostAdapter | null = null;
let serverAdapter: HostAdapter | null = null;

/** Browser: one adapter with persisted feedback. Server render: a separate stateless one. */
export function senseWeaveAdapter(): HostAdapter {
  if (typeof window === "undefined") return (serverAdapter ??= createHostAdapter({ preset: "explain", minChars: SENSEWEAVE_MIN_CHARS }));
  return (adapter ??= createHostAdapter({
    preset: "explain",
    minChars: SENSEWEAVE_MIN_CHARS,
    preferences: { initial: readPreferences(), onChange: writePreferences },
  }));
}

/**
 * Preset from the learner's question. Conservative: anything unclear is "explain".
 * Presets only narrow what may be shown; SenseWeave never adds content the answer did not state.
 */
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

export function prepareSenseWeave(message: { id: string; text: string }, question: string | undefined): PreparedAnswer {
  return senseWeaveAdapter().prepare(message.text, { id: message.id, preset: senseWeavePreset(question), prompt: question });
}

/** For the diagnostics line and tests; counters live only in this tab. */
export function senseWeaveStats() {
  return senseWeaveAdapter().stats();
}
