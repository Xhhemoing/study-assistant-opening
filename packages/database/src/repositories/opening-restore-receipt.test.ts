import { describe, expect, it } from "vitest";
import { formatOpeningRestoreObjectSideEffects } from "./opening-restore-receipt";
describe("CLI object side effects", () => {
  it("prints remaining and uncertain keys, not a clean receipt", () => {
    expect(formatOpeningRestoreObjectSideEffects({ status: "unknown", createdKeys: ["first"], remainingKeys: ["first"], unknownKeys: ["second"] }))
      .toBe('  objectSideEffects.status=unknown\n  objectSideEffects.createdKeys=["first"]\n  objectSideEffects.remainingKeys=["first"]\n  objectSideEffects.unknownKeys=["second"]\n');
  });
  it("prints clean compensation and no outstanding keys", () => {
    expect(formatOpeningRestoreObjectSideEffects({ status: "clean", createdKeys: ["first"], remainingKeys: [], unknownKeys: [] }))
      .toBe('  objectSideEffects.status=clean\n  objectSideEffects.createdKeys=["first"]\n  objectSideEffects.remainingKeys=[]\n  objectSideEffects.unknownKeys=[]\n');
    expect(formatOpeningRestoreObjectSideEffects(undefined)).toBe("");
  });
});
