import { describe, expect, it } from "vitest";
import {
  createExplorationRequestSchema,
  explorationBlockSchema,
  explorationSchema,
  explorationStatusRequestSchema,
} from "./exploration";

const id = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-08-04T08:00:00.000Z";

describe("persisted exploration contracts", () => {
  it("accepts a goal-free exploration and status response", () => {
    expect(createExplorationRequestSchema.parse({ title: "Understand queues" })).toEqual({
      title: "Understand queues",
    });
    expect(explorationSchema.parse({
      id,
      workspaceId: id,
      ownerUserId: id,
      courseId: null,
      goalId: null,
      title: "Understand queues",
      status: "open",
      closedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).courseId).toBeNull();
    expect(explorationStatusRequestSchema.parse({ status: "closed" })).toEqual({ status: "closed" });
  });

  it("accepts each persisted block kind", () => {
    for (const kind of ["scratch", "hypothesis", "open_question"] as const) {
      expect(explorationBlockSchema.parse({
        id,
        workspaceId: id,
        explorationId: id,
        branchId: id,
        kind,
        content: "A useful observation",
        position: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).kind).toBe(kind);
    }
  });

  it("rejects blank titles, invalid kinds, and oversized block content", () => {
    expect(() => createExplorationRequestSchema.parse({ title: "   " })).toThrow();
    expect(() => explorationBlockSchema.parse({
      id,
      workspaceId: id,
      explorationId: id,
      branchId: id,
      kind: "chat",
      content: "content",
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    })).toThrow();
    expect(() => explorationBlockSchema.parse({
      id,
      workspaceId: id,
      explorationId: id,
      branchId: id,
      kind: "scratch",
      content: "x".repeat(20_001),
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    })).toThrow();
  });
});
