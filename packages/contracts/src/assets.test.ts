import { describe, expect, it } from "vitest";
import {
  assetSchema,
  assetTypeSchema,
  assetLifecycleSchema,
  canTransitionLifecycle,
  assertLifecycleTransition,
  LifecycleTransitionError,
  type Asset,
  type AssetLifecycle,
} from "./assets";
import { workspaceSchema, workspaceIdSchema } from "./workspace";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const now = "2026-07-22T12:00:00.000Z";

function validAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: assetId,
    workspaceId,
    type: "document",
    lifecycle: "scratch",
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workspace contract", () => {
  it("accepts a workspace with a stable UUID id", () => {
    const workspace = workspaceSchema.parse({
      id: workspaceId,
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    expect(workspace.id).toBe(workspaceId);
    expect(workspaceIdSchema.parse(workspace.id)).toBe(workspaceId);
  });

  it("rejects non-UUID workspace ids", () => {
    expect(() => workspaceIdSchema.parse("ws-not-uuid")).toThrow();
  });
});

describe("asset type and lifecycle enums", () => {
  it("covers the six asset types", () => {
    for (const type of [
      "source",
      "document",
      "block",
      "card",
      "practice-item",
      "artifact",
    ] as const) {
      expect(assetTypeSchema.parse(type)).toBe(type);
    }
  });

  it("covers the six lifecycle states", () => {
    for (const lifecycle of [
      "scratch",
      "candidate",
      "confirmed",
      "published",
      "archived",
      "discarded",
    ] as const) {
      expect(assetLifecycleSchema.parse(lifecycle)).toBe(lifecycle);
    }
  });
});

describe("asset identity envelope", () => {
  it("parses a workspace-scoped asset with schema version and timestamps", () => {
    const asset = assetSchema.parse(validAsset());

    expect(asset.id).toBe(assetId);
    expect(asset.workspaceId).toBe(workspaceId);
    expect(asset.schemaVersion).toBe(1);
    expect(asset.createdAt).toBe(now);
    expect(asset.updatedAt).toBe(now);
  });

  it("does not require course membership on asset identity", () => {
    const asset = assetSchema.parse(validAsset());
    expect(asset).not.toHaveProperty("courseId");
    expect(asset).not.toHaveProperty("courseIds");
  });

  it("rejects assets with invalid UUIDs or missing timestamps", () => {
    expect(() => assetSchema.parse(validAsset({ id: "not-a-uuid" }))).toThrow();
    expect(() =>
      assetSchema.parse({
        ...validAsset(),
        createdAt: undefined,
      }),
    ).toThrow();
    expect(() =>
      assetSchema.parse({
        ...validAsset(),
        schemaVersion: 0,
      }),
    ).toThrow();
  });
});

describe("lifecycle transitions", () => {
  const allowed: Array<[AssetLifecycle, AssetLifecycle]> = [
    ["scratch", "candidate"],
    ["scratch", "confirmed"],
    ["scratch", "archived"],
    ["scratch", "discarded"],
    ["candidate", "confirmed"],
    ["candidate", "scratch"],
    ["candidate", "archived"],
    ["candidate", "discarded"],
    ["confirmed", "published"],
    ["confirmed", "archived"],
    ["confirmed", "discarded"],
    ["published", "archived"],
    ["published", "confirmed"],
    ["archived", "confirmed"],
    ["archived", "discarded"],
  ];

  const forbidden: Array<[AssetLifecycle, AssetLifecycle]> = [
    ["published", "scratch"],
    ["published", "candidate"],
    ["confirmed", "scratch"],
    ["confirmed", "candidate"],
    ["archived", "scratch"],
    ["archived", "candidate"],
    ["archived", "published"],
    ["discarded", "scratch"],
    ["discarded", "candidate"],
    ["discarded", "confirmed"],
    ["discarded", "published"],
    ["discarded", "archived"],
    ["scratch", "published"],
    ["candidate", "published"],
  ];

  it("allows valid promotions, archival, and reactivation", () => {
    for (const [from, to] of allowed) {
      expect(canTransitionLifecycle(from, to)).toBe(true);
      expect(() => assertLifecycleTransition(from, to)).not.toThrow();
    }
  });

  it("rejects invalid demotions and any transition out of discarded", () => {
    for (const [from, to] of forbidden) {
      expect(canTransitionLifecycle(from, to)).toBe(false);
      expect(() => assertLifecycleTransition(from, to)).toThrow(
        LifecycleTransitionError,
      );
    }
  });

  it("treats same-state transitions as no-ops (allowed)", () => {
    for (const state of assetLifecycleSchema.options) {
      expect(canTransitionLifecycle(state, state)).toBe(true);
    }
  });
});
