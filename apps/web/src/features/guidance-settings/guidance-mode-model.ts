import type { GuidanceMode } from "@aistudy/domain";

export const GUIDANCE_MODE_OPTIONS: Array<{
  value: GuidanceMode;
  label: string;
  description: string;
}> = [
  {
    value: "free",
    label: "自由模式",
    description: "不自动生成计划，也不锁定任何功能，完全由你主导。",
  },
  {
    value: "advisory",
    label: "建议模式",
    description: "系统给出建议，但需你确认后才执行。",
  },
  {
    value: "coach",
    label: "教练模式",
    description: "可在每日预算内自动重排未来任务，但不改历史与已确认知识。",
  },
];

export function defaultGuidanceMode(): GuidanceMode {
  return "advisory";
}

export function guidanceModeLabel(mode: GuidanceMode): string {
  const option = GUIDANCE_MODE_OPTIONS.find((item) => item.value === mode);
  return option ? option.label : mode;
}

/** Daily protected exploration slot, stored as HH:mm in 24-hour form. */
export interface DailyProtectedSlot {
  start: string;
  end: string;
}

const TIME_PATTERN = /^\d{2}:\d{2}$/;

export function isValidDailySlot(slot: DailyProtectedSlot): boolean {
  return (
    TIME_PATTERN.test(slot.start) &&
    TIME_PATTERN.test(slot.end) &&
    slot.start < slot.end
  );
}

export function dailySlotsEqual(a: DailyProtectedSlot, b: DailyProtectedSlot): boolean {
  return a.start === b.start && a.end === b.end;
}
