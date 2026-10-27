import type { LearningPreferences } from "@aistudy/contracts";
import type { GuidanceMode } from "../../../lib/data/types";

export type WorkspaceEntry = "learn" | "explore" | "library";

/** 持久值沿用 learn / explore / library；在 Opening 中分别对应 学习 / 助理 / 知识库。 */
export const workspaceEntries: Array<{ value: WorkspaceEntry; label: string }> = [
  { value: "explore", label: "助理（未设置时的默认）" },
  { value: "learn", label: "学习" },
  { value: "library", label: "知识库" },
];

export const guidanceModes: Array<{ value: GuidanceMode; label: string }> = [
  { value: "direct", label: "直接讲解" },
  { value: "balanced", label: "平衡" },
  { value: "socratic", label: "苏格拉底式追问" },
];

export const disabledLearningPreferences: LearningPreferences = {
  autoGradeOnSave: true,
  assessmentEnabled: false,
  retestSuggestionsEnabled: false,
  automaticRemindersEnabled: false,
};

export const learningSwitches: Array<{ key: keyof LearningPreferences; label: string }> = [
  { key: "autoGradeOnSave", label: "首次提交自动批改（工作区）" },
  { key: "assessmentEnabled", label: "自动评价" },
  { key: "retestSuggestionsEnabled", label: "补测建议" },
  { key: "automaticRemindersEnabled", label: "自动学习提醒" },
];

export type WorkspacePreferencesPayload = {
  defaultEntry?: WorkspaceEntry | null;
  learningPreferences?: LearningPreferences;
};

export async function fetchWorkspacePreferences(): Promise<WorkspacePreferencesPayload> {
  const response = await fetch("/api/workspace/preferences", { cache: "no-store" });
  if (!response.ok) throw new Error("preferences_unavailable");
  return response.json() as Promise<WorkspacePreferencesPayload>;
}

export async function putWorkspacePreferences(body: Record<string, unknown>): Promise<WorkspacePreferencesPayload> {
  const response = await fetch("/api/workspace/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("preferences_save_failed");
  return response.json() as Promise<WorkspacePreferencesPayload>;
}
