"use client";

import type { ThinTutorActionView } from "../client/api";

/**
 * LAB-U01 chips click semantics, fixed by the Lab duo design v2 §4:
 * each kind has exactly one defined click behavior and write boundary.
 * No progress bars, no mastery wording, recommendations stay read-only.
 */

export const TUTOR_ACTION_KIND_LABEL: Record<ThinTutorActionView["kind"], string> = {
  clarify: "先选定材料页",
  guided: "继续引导讲解",
  worked_example: "看完整例题",
  independent_variant: "试一道独立变式",
  delayed_retest: "到期重测",
};

export type TutorActionIntent =
  | { kind: "clarify"; action: ThinTutorActionView }
  | { kind: "guided"; action: ThinTutorActionView; mode: "hint" }
  | { kind: "worked_example"; action: ThinTutorActionView; mode: "explain" }
  | { kind: "independent_variant"; action: ThinTutorActionView; draft: string }
  | { kind: "delayed_retest"; action: ThinTutorActionView };

export const INDEPENDENT_VARIANT_NOTICE =
  "请先独立作答；如需提示请明确说明。看过完整解析的题不能算独立完成。";

export function independentVariantPrompt(action: ThinTutorActionView): string {
  const topic = action.skillLabel.trim();
  return [
    `我想围绕「${topic}」独立做一道变式题`,
    action.problemRef ? `（参考原题：${action.problemRef}）` : null,
    "。请不要先给提示；我先给出我自己的解答，再请你看我的过程。",
    INDEPENDENT_VARIANT_NOTICE,
  ]
    .filter(Boolean)
    .join("");
}

/**
 * Pure mapping from a server recommendation to a UI intent. The caller owns
 * every write; this function never fetches, submits or mutates.
 */
export function tutorActionIntent(action: ThinTutorActionView): TutorActionIntent {
  switch (action.kind) {
    case "guided":
      return { kind: "guided", action, mode: "hint" };
    case "worked_example":
      return { kind: "worked_example", action, mode: "explain" };
    case "independent_variant":
      return { kind: "independent_variant", action, draft: independentVariantPrompt(action) };
    case "clarify":
      return { kind: "clarify", action };
    case "delayed_retest":
      return { kind: "delayed_retest", action };
  }
}
