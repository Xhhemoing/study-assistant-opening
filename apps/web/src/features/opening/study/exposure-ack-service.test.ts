import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";

const boundary = vi.hoisted(() => ({ create: vi.fn(), acknowledge: vi.fn() }));
vi.mock("@aistudy/database", () => ({ createOpeningStudyExposureRepository: boundary.create }));
import { createOpeningStudyExposureService } from "./exposure-service";

const sql = {} as Sql;
const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const receiptId = "33333333-3333-4333-8333-333333333333";
const receipt = { id: receiptId, releaseKey: "existing:receipt", contextAnchor: { purpose: "learning_help" }, origin: "assistant",
  supportDomain: "unknown", generatedAt: "2026-10-20T00:00:00.000Z", releasedAt: "2026-10-20T00:00:01.000Z",
  acknowledgedAt: "2026-10-20T00:00:02.000Z", historyRevision: 5 };
beforeEach(() => {
  vi.clearAllMocks(); boundary.create.mockReturnValue({ acknowledge: boundary.acknowledge });
  boundary.acknowledge.mockResolvedValue(receipt);
});

describe("existing ACK service input boundary", () => {
  it.each([
    ["undefined", undefined], ["null", null], ["number", 1], ["boolean", false], ["array", [receiptId]],
    ["object", { id: receiptId }], ["empty", ""], ["whitespace", " "], ["truncated", receiptId.slice(0, -1)],
    ["prefix", `x${receiptId}`], ["suffix", `${receiptId}x`], ["wrapped", ` ${receiptId} `],
    ["invalid UUID variant", "33333333-3333-4333-7333-333333333333"],
  ] as const)("rejects %s before issuing any repository ACK", async (_name, input) => {
    const service = createOpeningStudyExposureService(sql);
    expect(() => service.acknowledge(scope, input)).toThrow();
    expect(boundary.acknowledge).not.toHaveBeenCalled();
  });
  it("passes the valid identifier and caller scope unchanged and returns the repository's receipt", async () => {
    const service = createOpeningStudyExposureService(sql);
    await expect(service.acknowledge(scope, receiptId)).resolves.toBe(receipt);
    expect(boundary.create).toHaveBeenCalledWith(sql);
    expect(boundary.acknowledge).toHaveBeenCalledExactlyOnceWith(scope, receiptId);
  });
  it("forwards each duplicate request rather than locally inventing an ACK or timestamp", async () => {
    const service = createOpeningStudyExposureService(sql);
    const first = await service.acknowledge(scope, receiptId), second = await service.acknowledge(scope, receiptId);
    expect(first).toBe(receipt); expect(second).toBe(receipt);
    expect(boundary.acknowledge).toHaveBeenCalledTimes(2);
    expect(boundary.acknowledge.mock.calls).toEqual([[scope, receiptId], [scope, receiptId]]);
  });
  it.each(["NOT_FOUND", "CONFLICT", "08006"])("does not mask repository %s failure as a successful ACK", async code => {
    const failure = Object.assign(new Error("synthetic repository failure"), { code });
    boundary.acknowledge.mockRejectedValue(failure);
    await expect(createOpeningStudyExposureService(sql).acknowledge(scope, receiptId)).rejects.toBe(failure);
    expect(boundary.acknowledge).toHaveBeenCalledExactlyOnceWith(scope, receiptId);
  });
});
