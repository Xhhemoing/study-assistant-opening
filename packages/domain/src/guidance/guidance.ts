export const GUIDANCE_POLICY_VERSION = "guidance-1";

export type GuidanceMode = "free" | "advisory" | "coach";

export interface GuidancePolicy {
  mode: GuidanceMode;
  /** Whether the system may generate or reorder a plan without asking. */
  autoPlan: boolean;
  /** Whether suggestions must be confirmed before taking effect. */
  requiresConfirmation: boolean;
  /** Feature identifiers disabled under this mode. */
  blockedFeatures: readonly string[];
}

const MUTATE_HISTORY = "mutate-history";
const MUTATE_CONFIRMED = "mutate-confirmed";

export function getGuidancePolicy(mode: GuidanceMode): GuidancePolicy {
  switch (mode) {
    case "free":
      return {
        mode,
        autoPlan: false,
        requiresConfirmation: false,
        blockedFeatures: [],
      };
    case "advisory":
      return {
        mode,
        autoPlan: false,
        requiresConfirmation: true,
        blockedFeatures: [],
      };
    case "coach":
      return {
        mode,
        autoPlan: true,
        requiresConfirmation: false,
        blockedFeatures: [MUTATE_HISTORY, MUTATE_CONFIRMED],
      };
  }
}

export interface ReorderTarget {
  isHistory: boolean;
  isConfirmed: boolean;
  isLocked: boolean;
  estimatedMinutes: number;
}

export function canReorderTask(
  policy: GuidancePolicy,
  target: ReorderTarget,
  remainingBudgetMinutes: number,
): boolean {
  if (!policy.autoPlan) return false;
  if (policy.blockedFeatures.includes(MUTATE_HISTORY) && target.isHistory) return false;
  if (policy.blockedFeatures.includes(MUTATE_CONFIRMED) && target.isConfirmed) return false;
  if (target.isLocked) return false;
  return target.estimatedMinutes <= remainingBudgetMinutes;
}

export interface TimeSlot {
  startsAt: string;
  endsAt: string;
}

export function slotsOverlap(a: TimeSlot, b: TimeSlot): boolean {
  const aStart = Date.parse(a.startsAt);
  const aEnd = Date.parse(a.endsAt);
  const bStart = Date.parse(b.startsAt);
  const bEnd = Date.parse(b.endsAt);
  return aStart < bEnd && bStart < aEnd;
}

export function canScheduleIntoSlot(
  candidate: TimeSlot,
  protectedSlots: TimeSlot[],
): boolean {
  return !protectedSlots.some((slot) => slotsOverlap(candidate, slot));
}

export function reserveProtectedSlot(slots: TimeSlot[], slot: TimeSlot): TimeSlot[] {
  return [...slots, slot].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
}
