import { describe, expect, it, vi } from "vitest";
import { createMeasurementClient } from "./client";

const empty = {
  trial: null, attempts: [], nextDueAt: null,
  report: { conclusion: "insufficient_evidence", presented: 0, answered: 0, pending: 0, skipped: 0, eligible: 0, excluded: {}, models: [], byPhase: [], bySkill: [], pairedBrierDifference: null, pairedLogLossDifference: null },
};
const courseId = "11111111-1111-4111-8111-111111111111";

describe("measurement HTTP client", () => {
  it("includes archived courses so existing trials remain accessible", async () => {
    const courses = [
      { id: courseId, title: "Archived", archivedAt: "2026-10-16T00:00:00.000Z" },
      { id: "22222222-2222-4222-8222-222222222222", title: "Active", archivedAt: null },
    ];
    const fetcher = vi.fn().mockResolvedValue(Response.json({ courses }));
    await expect(createMeasurementClient(fetcher).courses()).resolves.toEqual(courses);
    expect(fetcher).toHaveBeenCalledWith("/api/courses?includeArchived=true", { method: "GET", cache: "no-store" });
  });
  it("validates returned records and never uses a cached response", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(empty));
    await expect(createMeasurementClient(fetcher).read(courseId)).resolves.toEqual(empty);
    expect(fetcher).toHaveBeenCalledWith(`/api/opening/measurement?courseId=${courseId}`, { method: "GET", cache: "no-store" });
  });
  it("preserves the same supplied idempotency key and action without client grading", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(empty));
    const client = createMeasurementClient(fetcher);
    const action = { action: "answer" as const, clientKey: "retry-key-123", answer: "B" };
    await client.act(courseId, action);
    await client.act(courseId, action);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(fetcher.mock.calls[1]?.[1]);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual(action);
  });
  it("rejects malformed successful responses and invalid actions", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ trial: null }));
    await expect(createMeasurementClient(fetcher).read(courseId)).rejects.toThrow();
    expect(() => createMeasurementClient(fetcher).act(courseId, { action: "answer", clientKey: "retry-key-123", answer: "" })).toThrow();
  });
  it("makes authentication expiry explicit and keeps internal server failures out of the UI", async () => {
    const expired = vi.fn().mockResolvedValue(Response.json({ error: { message: "raw" } }, { status: 401 }));
    await expect(createMeasurementClient(expired).read(courseId)).rejects.toThrow("登录状态已过期");
    const failed = vi.fn().mockResolvedValue(Response.json({ error: { message: "secret SQL statement" } }, { status: 500 }));
    await expect(createMeasurementClient(failed).read(courseId)).rejects.toThrow("测试服务暂不可用");
  });
});
