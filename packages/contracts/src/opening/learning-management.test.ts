import { expect, it } from "vitest";
import { learningManagementCommandSchema, learningManagementSettingsSchema, learningCardSessionCommandSchema } from "./learning-management";
it("requires an explicit cap and a versioned settings update", () => {
  expect(learningManagementSettingsSchema.safeParse({ dailyMinutes: 0, bufferMinutes: 0, revision: 1, updatedAt: new Date().toISOString() }).success).toBe(false);
  expect(learningManagementCommandSchema.safeParse({ action: "settings", dailyMinutes: 60, bufferMinutes: 5 }).success).toBe(false);
});
it("does not allow an accepted plan to be silently overwritten", () => {
  expect(learningManagementCommandSchema.safeParse({ action: "preview", date: "2026-11-01", expectedAcceptedVersion: 0, expectedBudgetRevision: 1, clientKey: "test-key-1", overwriteAccepted: true }).success).toBe(false);
});
it("requires the original card session version and explicit active time at stop", () => {
  expect(learningCardSessionCommandSchema.safeParse({ action: "stop", activityId: "00000000-0000-4000-8000-000000000001", expectedRevision: 1, elapsedSeconds: -1, reviewedCardIds: [], reason: "time_used" }).success).toBe(false);
});
