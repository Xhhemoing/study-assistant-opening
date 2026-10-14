import type { OpeningGuidanceSettings, TimeBlock } from "@aistudy/contracts";
import { zonedLocalInstant, assertValidLocalDate } from "./local-day-bounds";
/** These are user-protected windows in the workspace timezone, not machine timezone. */
export function guidanceProtectedBlocks(day: string, timeZone: string, settings: OpeningGuidanceSettings): TimeBlock[] {
  assertValidLocalDate(day);
  return settings.protectedSlots.map(slot => {
    const start = zonedLocalInstant(`${day}T${slot.start}`, timeZone), end = zonedLocalInstant(`${day}T${slot.end}`, timeZone);
    if (end <= start) throw new RangeError("protected slot has no valid duration in the selected timezone");
    return { start: start.toISOString(), end: end.toISOString(), kind: "locked" };
  });
}
