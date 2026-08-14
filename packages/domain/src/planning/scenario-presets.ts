import type { ScenarioPreset, StatusWord } from "@aistudy/contracts";

export interface ScenarioPresetDefinition {
  id: ScenarioPreset;
  version: string;
  displayName: string;
  tierOrder: Array<Exclude<StatusWord, "stable">>;
  reasonByStatus: Record<Exclude<StatusWord, "stable">, string>;
}

const PRESETS: Record<ScenarioPreset, ScenarioPresetDefinition> = {
  final: {
    id: "final",
    version: "1.0.0",
    displayName: "期末考试",
    tierOrder: ["weak", "untested", "usable"],
    reasonByStatus: {
      weak: "薄弱考点，优先补缺",
      untested: "尚未测评，先建立基线",
      usable: "做一道变式保持手感",
    },
  },
  gaokao: {
    id: "gaokao",
    version: "1.0.0",
    displayName: "高考",
    tierOrder: ["weak", "usable", "untested"],
    reasonByStatus: {
      weak: "薄弱考点，优先补缺",
      untested: "尚未测评，先建立基线",
      usable: "做一道变式保持手感",
    },
  },
  kaoyan: {
    id: "kaoyan",
    version: "1.0.0",
    displayName: "考研",
    tierOrder: ["weak", "usable", "untested"],
    reasonByStatus: {
      weak: "薄弱考点，优先补缺",
      untested: "尚未测评，先建立基线",
      usable: "做一道变式保持手感",
    },
  },
  custom: {
    id: "custom",
    version: "1.0.0",
    displayName: "自定义",
    tierOrder: ["weak", "untested", "usable"],
    reasonByStatus: {
      weak: "薄弱考点，优先补缺",
      untested: "尚未测评，先建立基线",
      usable: "做一道变式保持手感",
    },
  },
};

export function getScenarioPresetDefinition(preset: ScenarioPreset): ScenarioPresetDefinition {
  const def = PRESETS[preset];
  if (!def) {
    throw new Error(`unknown scenario preset: ${preset}`);
  }
  return def;
}

export function listKnownScenarioPresets(): ScenarioPresetDefinition[] {
  return Object.values(PRESETS);
}
