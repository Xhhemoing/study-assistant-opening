import { describe, expect, it } from "vitest";
import {
  SHAREABLE_PITFALL_CATALOG,
  getShareablePitfallById,
  isKnownShareablePitfallId,
  listShareablePitfalls,
} from "./catalog";

describe("authoritative shareable pitfall catalog", () => {
  it("contains unique pitfall IDs covering 408, higher math, and IELTS with bounded copy", () => {
    const entries = listShareablePitfalls();
    expect(entries.length).toBeGreaterThanOrEqual(10);
    expect(entries).toBe(SHAREABLE_PITFALL_CATALOG);

    const ids = new Set(entries.map((entry) => entry.pitfallId));
    expect(ids.size).toBe(entries.length);

    expect(entries.some((e) => e.pitfallId.startsWith("408-"))).toBe(true);
    expect(entries.some((e) => e.pitfallId.startsWith("math-"))).toBe(true);
    expect(entries.some((e) => e.pitfallId.startsWith("ielts-"))).toBe(true);

    for (const entry of entries) {
      expect(entry.pitfallId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(entry.subjectLabel.length).toBeGreaterThan(0);
      expect(entry.subjectLabel.length).toBeLessThanOrEqual(40);
      expect(entry.pitfallTitle.length).toBeGreaterThan(0);
      expect(entry.pitfallTitle.length).toBeLessThanOrEqual(80);
      expect(entry.trapSummary.length).toBeGreaterThan(0);
      expect(entry.trapSummary.length).toBeLessThanOrEqual(180);
      expect(entry.takeawayRule.length).toBeGreaterThan(0);
      expect(entry.takeawayRule.length).toBeLessThanOrEqual(180);
      // Unwired cohort aggregation must honestly stay 0 / null.
      expect(entry.cohortSampleSize).toBe(0);
      expect(entry.cohortTrapRate).toBeNull();
    }
  });

  it("distinguishes the temporary fast recovery window from the 408 round-based window", () => {
    const tcp = getShareablePitfallById("408-cn-tcp-congestion-ssthresh");
    expect(tcp?.trapSummary).toContain("第 3 个重复 ACK");
    expect(tcp?.trapSummary).toContain("ssthresh = max(FlightSize / 2, 2 × SMSS)");
    expect(tcp?.takeawayRule).toMatch(/快恢复.*cwnd = ssthresh \+ 3 × SMSS/);
    expect(tcp?.takeawayRule).toMatch(/确认新数据后.*cwnd 回落到 ssthresh，进入拥塞避免/);
    expect(tcp?.takeawayRule).toMatch(/408.*RTT.*FlightSize = cwnd.*从新门限起每轮增加 1 SMSS/);
  });

  it("resolves known IDs and rejects unknown or prototype-property keys", () => {
    const mathEntry = getShareablePitfallById("math-calculus-lhopital-form");
    expect(mathEntry?.subjectLabel).toBe("高等数学");
    expect(isKnownShareablePitfallId("math-calculus-lhopital-form")).toBe(true);

    for (const unknown of ["unknown-pitfall", "", "toString", "constructor", "__proto__"]) {
      expect(getShareablePitfallById(unknown)).toBeNull();
      expect(isKnownShareablePitfallId(unknown)).toBe(false);
    }
  });
});
