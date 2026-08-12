import type {
  AbilityDimension,
  AssessmentMode,
  CourseRequirementInput,
  RequirementProfileKind,
} from "@aistudy/contracts";
import { REQUIREMENT_PROFILES } from "@aistudy/domain";

export const REQUIREMENT_PROFILE_OPTIONS = REQUIREMENT_PROFILES.map((preset) => ({
  value: preset.kind,
  label: preset.label,
  description: preset.description,
}));

export const ABILITY_DIMENSION_LABELS: Record<AbilityDimension, string> = {
  recognition: "识别",
  recall: "无提示回忆",
  procedural: "程序执行",
  transfer: "迁移应用",
  expression: "表达输出",
  timed: "限时稳定",
};

export interface RequirementProfileDraft {
  kind: RequirementProfileKind;
  assessmentMode: AssessmentMode;
}

export function defaultRequirementProfileDraft(): RequirementProfileDraft {
  return { kind: "free-exploration", assessmentMode: "basic" };
}

export function requirementProfileDraftToInput(
  draft: RequirementProfileDraft,
): CourseRequirementInput {
  return { kind: draft.kind, assessmentMode: draft.assessmentMode };
}

export function requirementProfileLabel(kind: RequirementProfileKind): string {
  const preset = REQUIREMENT_PROFILES.find((item) => item.kind === kind);
  return preset ? preset.label : kind;
}
