import { describe, expect, it } from "vitest";
import { formatFocusTime, remainingFocusSeconds } from "./focus-timer-model";

describe("local focus timer", () => {
  it("recomputes from the deadline after a delayed tick or background return", () => {
    expect(remainingFocusSeconds(100000, 0)).toBe(100);
    expect(remainingFocusSeconds(100000, 42450)).toBe(58);
    expect(remainingFocusSeconds(100000, 101000)).toBe(0);
  });
  it("formats start and completion for the clock", () => {
    expect(formatFocusTime(25 * 60)).toBe("25:00");
    expect(formatFocusTime(61)).toBe("01:01");
    expect(formatFocusTime(0)).toBe("00:00");
  });
});
