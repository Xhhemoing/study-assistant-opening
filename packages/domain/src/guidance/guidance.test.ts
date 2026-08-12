import { describe, expect, it } from "vitest";
import {
  canReorderTask,
  canScheduleIntoSlot,
  getGuidancePolicy,
  GUIDANCE_POLICY_VERSION,
  reserveProtectedSlot,
  slotsOverlap,
  type ReorderTarget,
  type TimeSlot,
} from "./guidance";

const futureTask: ReorderTarget = {
  isHistory: false,
  isConfirmed: false,
  isLocked: false,
  estimatedMinutes: 20,
};

describe("guidance modes", () => {
  it("is versioned", () => {
    expect(GUIDANCE_POLICY_VERSION).toBe("guidance-1");
  });

  it("free mode: no auto-plan and no blocked features", () => {
    const policy = getGuidancePolicy("free");
    expect(policy.autoPlan).toBe(false);
    expect(policy.requiresConfirmation).toBe(false);
    expect(policy.blockedFeatures).toEqual([]);
  });

  it("advisory mode: suggestions require confirmation", () => {
    const policy = getGuidancePolicy("advisory");
    expect(policy.autoPlan).toBe(false);
    expect(policy.requiresConfirmation).toBe(true);
  });

  it("coach mode: may auto-plan within budget", () => {
    const policy = getGuidancePolicy("coach");
    expect(policy.autoPlan).toBe(true);
    expect(policy.requiresConfirmation).toBe(false);
  });

  it("coach mode blocks mutation of history and confirmed knowledge", () => {
    const policy = getGuidancePolicy("coach");
    expect(policy.blockedFeatures).toContain("mutate-history");
    expect(policy.blockedFeatures).toContain("mutate-confirmed");
  });

  it("coach may reorder a future unconfirmed task inside budget", () => {
    expect(canReorderTask(getGuidancePolicy("coach"), futureTask, 30)).toBe(true);
  });

  it("coach cannot exceed the remaining budget", () => {
    expect(canReorderTask(getGuidancePolicy("coach"), futureTask, 10)).toBe(false);
  });

  it("coach cannot reorder history, confirmed knowledge, or locked tasks", () => {
    const policy = getGuidancePolicy("coach");
    expect(canReorderTask(policy, { ...futureTask, isHistory: true }, 30)).toBe(false);
    expect(canReorderTask(policy, { ...futureTask, isConfirmed: true }, 30)).toBe(false);
    expect(canReorderTask(policy, { ...futureTask, isLocked: true }, 30)).toBe(false);
  });

  it("free and advisory never reorder automatically", () => {
    expect(canReorderTask(getGuidancePolicy("free"), futureTask, 100)).toBe(false);
    expect(canReorderTask(getGuidancePolicy("advisory"), futureTask, 100)).toBe(false);
  });

  it("detects overlapping time slots", () => {
    const slot: TimeSlot = { startsAt: "2026-08-13T18:00:00.000Z", endsAt: "2026-08-13T19:00:00.000Z" };
    expect(slotsOverlap(slot, { startsAt: "2026-08-13T18:30:00.000Z", endsAt: "2026-08-13T19:30:00.000Z" })).toBe(true);
    expect(slotsOverlap(slot, { startsAt: "2026-08-13T19:00:00.000Z", endsAt: "2026-08-13T20:00:00.000Z" })).toBe(false);
  });

  it("respects reserved protected exploration time", () => {
    const protectedSlots: TimeSlot[] = [
      { startsAt: "2026-08-13T19:00:00.000Z", endsAt: "2026-08-13T20:00:00.000Z" },
    ];
    const overlapping: TimeSlot = { startsAt: "2026-08-13T19:30:00.000Z", endsAt: "2026-08-13T20:30:00.000Z" };
    const outside: TimeSlot = { startsAt: "2026-08-13T21:00:00.000Z", endsAt: "2026-08-13T21:30:00.000Z" };
    expect(canScheduleIntoSlot(overlapping, protectedSlots)).toBe(false);
    expect(canScheduleIntoSlot(outside, protectedSlots)).toBe(true);
    expect(canScheduleIntoSlot(outside, [])).toBe(true);
  });

  it("appends reserved slots in chronological order", () => {
    const first: TimeSlot = { startsAt: "2026-08-13T20:00:00.000Z", endsAt: "2026-08-13T21:00:00.000Z" };
    const second: TimeSlot = { startsAt: "2026-08-13T18:00:00.000Z", endsAt: "2026-08-13T19:00:00.000Z" };
    const reserved = reserveProtectedSlot(reserveProtectedSlot([], first), second);
    expect(reserved).toHaveLength(2);
    expect(reserved[0]).toEqual(second);
    expect(reserved[1]).toEqual(first);
  });
});
