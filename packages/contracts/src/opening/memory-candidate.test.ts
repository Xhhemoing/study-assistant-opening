import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { memoryCandidateDecisionSchema } from "./memory-candidate";

const id = randomUUID();
const future = "2099-01-01T00:00:00.000Z";

describe("memoryCandidateDecisionSchema", () => {
  it("accepts an initial permanent confirm and a temporary confirm with a future expiry", () => {
    expect(
      memoryCandidateDecisionSchema.parse({
        id,
        expectedVersion: 0,
        clientKey: "confirm-key-1",
        action: "confirm",
      }),
    ).toMatchObject({ expectedVersion: 0, action: "confirm", expiresAt: null });
    expect(
      memoryCandidateDecisionSchema.parse({
        id,
        expectedVersion: 0,
        clientKey: "confirm-temp-1",
        action: "confirm",
        expiresAt: future,
      }).expiresAt,
    ).toBe(future);
  });

  it("accepts a past expiry structurally and a non-negative expectedVersion", () => {
    expect(
      memoryCandidateDecisionSchema.parse({
        id,
        expectedVersion: 0,
        clientKey: "replay-past-1",
        action: "confirm",
        expiresAt: "2000-01-01T00:00:00.000Z",
      }).expiresAt,
    ).toBe("2000-01-01T00:00:00.000Z");
    expect(
      memoryCandidateDecisionSchema.parse({
        id,
        expectedVersion: 1,
        clientKey: "replay-version-1",
        action: "confirm",
      }).expectedVersion,
    ).toBe(1);
  });

  it("rejects short keys, fractional versions, and non-datetime expiry", () => {
    expect(() =>
      memoryCandidateDecisionSchema.parse({
        id,
        expectedVersion: 0,
        clientKey: "short",
        action: "reject",
      }),
    ).toThrow();
    expect(() =>
      memoryCandidateDecisionSchema.parse({
        id,
        expectedVersion: -1,
        clientKey: "confirm-key-1",
        action: "confirm",
      }),
    ).toThrow();
    expect(() =>
      memoryCandidateDecisionSchema.parse({
        id,
        expectedVersion: 0,
        clientKey: "confirm-key-1",
        action: "confirm",
        expiresAt: "not-a-date",
      }),
    ).toThrow();
  });
});
