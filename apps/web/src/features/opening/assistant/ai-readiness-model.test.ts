import { describe, expect, it } from "vitest";
import { isAiReadinessChecklistHardBlocker, parserOcrReadinessItem } from "./ai-readiness-model";

describe("measured OCR readiness", () => {
  const now = Date.parse("2026-10-23T00:00:00Z");
  const stamp = { checkedAt: "2026-10-22T23:59:00Z", expiresAt: "2026-10-23T00:09:00Z", missingFiles: [] };
  it.each(["not_configured", "missing_files", "preflight_failed", "ready"] as const)("preserves %s without blocking text tutoring", status => {
    const item = parserOcrReadinessItem({ ...stamp, status }, now);
    expect(item.status).toBe(status);
    expect(item.ok).toBe(status === "ready");
    expect(isAiReadinessChecklistHardBlocker(item)).toBe(false);
    expect(item.checkedAt).toBe(stamp.checkedAt);
  });
  it("makes missing and expired observations unknown, not a configured/ready guess", () => {
    expect(parserOcrReadinessItem(null, now)).toMatchObject({ status: "unknown", ok: false, checkedAt: null });
    expect(parserOcrReadinessItem({ ...stamp, status: "ready", expiresAt: "2026-10-23T00:00:00Z" }, now)).toMatchObject({ status: "unknown", ok: false });
  });
});
