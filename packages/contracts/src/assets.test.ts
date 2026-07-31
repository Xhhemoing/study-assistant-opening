import { describe, it, expect } from "vitest";
import {
  assetTypeSchema,
  assetLifecycleSchema,
  assetSchema,
  AssetType,
  AssetLifecycle,
  LifecycleTransitionError,
  canTransitionLifecycle,
  assertLifecycleTransition,
} from "./assets";

const workspaceId = "11111111-1111-4111-8111-111111111111";

describe("asset contract", () => {
  describe("schemas", () => {
    it("accepts valid asset", () => {
      const asset = assetSchema.parse({
        id: workspaceId,
        workspaceId,
        type: "block",
        lifecycle: "candidate",
        schemaVersion: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      });
      expect(asset).toEqual({
        id: workspaceId,
        workspaceId,
        type: "block",
        lifecycle: "candidate",
        schemaVersion: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      });
    });

    it("rejects non-UUID asset id", () => {
      expect(() =>
        assetSchema.parse({
          id: "not-a-uuid",
          workspaceId,
          type: "block",
          lifecycle: "candidate",
          schemaVersion: 1,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        })
      ).toThrow();
    });

    it("rejects invalid workspaceId", () => {
      expect(() =>
        assetSchema.parse({
          id: workspaceId,
          workspaceId: "ws-123",
          type: "block",
          lifecycle: "candidate",
          schemaVersion: 1,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        })
      ).toThrow();
    });
  });

  describe("lifecycle", () => {
    it("accepts valid lifecycle", () => {
      const valid: AssetLifecycle[] = [
        "scratch",
        "candidate",
        "confirmed",
        "published",
        "archived",
        "discarded",
      ];
      for (const l of valid) {
        expect(assetLifecycleSchema.parse(l)).toBe(l);
      }
    });

    it("rejects invalid lifecycle", () => {
      expect(() => assetLifecycleSchema.parse("invalid")).toThrow();
    });
  });

  describe("asset type", () => {
    it("accepts valid types", () => {
      const valid: AssetType[] = ["source", "document", "block", "card", "practice-item", "artifact"];
      for (const t of valid) {
        expect(assetTypeSchema.parse(t)).toBe(t);
      }
    });

    it("rejects invalid type", () => {
      expect(() => assetTypeSchema.parse("invalid")).toThrow();
    });
  });

  describe("lifecycle transitions", () => {
    it("allows scratch → candidate", () => {
      expect(canTransitionLifecycle("scratch", "candidate")).toBe(true);
      expect(() => assertLifecycleTransition("scratch", "candidate")).not.toThrow();
    });

    it("allows candidate → confirmed", () => {
      expect(canTransitionLifecycle("candidate", "confirmed")).toBe(true);
      expect(() => assertLifecycleTransition("candidate", "confirmed")).not.toThrow();
    });

    it("rejects confirmed → scratch", () => {
      expect(canTransitionLifecycle("confirmed", "scratch")).toBe(false);
      expect(() => assertLifecycleTransition("confirmed", "scratch")).toThrow(LifecycleTransitionError);
    });

    it("rejects published → discarded", () => {
      expect(canTransitionLifecycle("published", "discarded")).toBe(false);
      expect(() => assertLifecycleTransition("published", "discarded")).toThrow(LifecycleTransitionError);
    });

    it("allows archived → confirmed", () => {
      expect(canTransitionLifecycle("archived", "confirmed")).toBe(true);
    });

    it("allows discarded → discarded only", () => {
      expect(canTransitionLifecycle("discarded", "discarded")).toBe(true);
      expect(canTransitionLifecycle("discarded", "confirmed")).toBe(false);
    });
  });
});
