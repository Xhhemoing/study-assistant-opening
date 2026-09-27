import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OpeningMemoryError } from "@aistudy/database";
import { ApiError } from "../../auth/service";
import type { Principal } from "../../../lib/authorization";
import { createOpeningMemoryCandidateService } from "./memory-candidate-service";

const workspaceId = randomUUID();
const userId = randomUUID();
const candidateId = randomUUID();
const sourceTurnId = randomUUID();

function principal(): Principal {
  return { userId, workspaceId, sessionId: randomUUID() };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: candidateId,
    workspaceId,
    courseId: null,
    kind: "confirmed",
    text: "喜欢提示",
    sourceTurnIds: [sourceTurnId],
    version: 1,
    expiresAt: null,
    status: "active",
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("opening memory candidate service", () => {
  it("delegates one confirm and returns a review card", async () => {
    const decideMemoryCandidate = vi.fn(async () => item());
    const service = createOpeningMemoryCandidateService({
      decideMemoryCandidate,
    } as never);
    const card = await service.decideCandidate(principal(), {
      id: candidateId,
      expectedVersion: 0,
      clientKey: "service-confirm-1",
      action: "confirm",
      expiresAt: null,
    });
    expect(decideMemoryCandidate).toHaveBeenCalledWith(
      { workspaceId, ownerUserId: userId },
      {
        id: candidateId,
        expectedVersion: 0,
        clientKey: "service-confirm-1",
        action: "confirm",
        expiresAt: null,
      },
    );
    expect(card).toMatchObject({ id: candidateId, kind: "confirmed", version: 1, why: [sourceTurnId] });
  });

  it("maps reject, temporary validation, and replay conflicts", async () => {
    const decideMemoryCandidate = vi
      .fn()
      .mockResolvedValueOnce(item({ kind: "candidate", status: "rejected", expiresAt: null }))
      .mockRejectedValueOnce(new OpeningMemoryError("VALIDATION", "temporary memory requires a future expiresAt"))
      .mockRejectedValueOnce(new OpeningMemoryError("CONFLICT", "memory candidate decision conflicts"));
    const service = createOpeningMemoryCandidateService({ decideMemoryCandidate } as never);
    const rejected = await service.decideCandidate(principal(), {
      id: candidateId,
      expectedVersion: 0,
      clientKey: "service-reject-1",
      action: "reject",
      expiresAt: null,
    });
    expect(rejected.status).toBe("rejected");
    await expect(service.decideCandidate(principal(), {
      id: candidateId,
      expectedVersion: 0,
      clientKey: "service-temp-1",
      action: "confirm",
      expiresAt: null,
    })).rejects.toMatchObject({ code: "VALIDATION", status: 422 });
    await expect(service.decideCandidate(principal(), {
      id: candidateId,
      expectedVersion: 0,
      clientKey: "service-conflict-1",
      action: "confirm",
      expiresAt: null,
    })).rejects.toBeInstanceOf(ApiError);
  });
});
