import { describe, expect, it } from "vitest";
import { OPENING_BACKUP_TABLES } from "./opening-backup-records";
import {
  evaluateOpeningRestoreEmptyNamespace,
  isOpeningRestoreNeverTable,
  OPENING_RESTORE_NEVER_TABLES,
  type OpeningRestoreNamespaceCounts,
} from "./opening-backup-empty-namespace";

function zeroCounts(): OpeningRestoreNamespaceCounts {
  return Object.fromEntries(OPENING_BACKUP_TABLES.map((t) => [t, 0])) as OpeningRestoreNamespaceCounts;
}

describe("evaluateOpeningRestoreEmptyNamespace", () => {
  it("accepts a complete zero map", () => {
    expect(evaluateOpeningRestoreEmptyNamespace(zeroCounts())).toEqual({ ok: true, totalRows: 0 });
  });

  it("rejects missing counts instead of assuming empty", () => {
    const result = evaluateOpeningRestoreEmptyNamespace({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("TARGET_NOT_EMPTY");
    expect(result.errors.some((e) => /missing or invalid count/i.test(e))).toBe(true);
  });

  it("rejects null/undefined counts", () => {
    expect(evaluateOpeningRestoreEmptyNamespace(null).ok).toBe(false);
    expect(evaluateOpeningRestoreEmptyNamespace(undefined).ok).toBe(false);
  });

  it("names occupied tables", () => {
    const counts = zeroCounts();
    counts.courses = 2;
    counts.opening_sources = 1;
    const result = evaluateOpeningRestoreEmptyNamespace(counts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.totalRows).toBe(3);
    expect(result.errors.join(" ")).toMatch(/courses has 2/);
    expect(result.errors.join(" ")).toMatch(/opening_sources has 1/);
  });
});

describe("OPENING_RESTORE_NEVER_TABLES", () => {
  it("bans secrets, sessions, and paid-job queues from restore", () => {
    for (const table of [
      "sessions",
      "opening_connection_credentials",
      "opening_model_provider_credentials",
      "opening_jobs",
      "opening_outbox",
      "opening_budget_reservations",
    ]) {
      expect(isOpeningRestoreNeverTable(table)).toBe(true);
    }
    expect(OPENING_RESTORE_NEVER_TABLES).not.toContain("opening_sources");
    expect(isOpeningRestoreNeverTable("opening_sources")).toBe(false);
  });
});
