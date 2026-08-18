import { describe, expect, it } from "vitest";
import {
  appendStatusCorrectionRequestSchema,
  assessmentQuerySchema,
} from "./learning-read-models";

const eventId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

describe("learning read-model contracts", () => {
  it("accepts an optional syllabus filter and rejects client-chosen workspace identity", () => {
    expect(assessmentQuerySchema.parse({}).syllabusPointId).toBeUndefined();
    expect(assessmentQuerySchema.parse({ syllabusPointId: eventId }).syllabusPointId).toBe(eventId);
    expect(
      assessmentQuerySchema.safeParse({
        syllabusPointId: eventId,
        workspaceId,
      }).success,
    ).toBe(false);
  });

  it("rejects correction bodies that carry workspace or user fields", () => {
    const valid = {
      correctsEventId: eventId,
      kind: "status" as const,
      note: "应为稳固",
      overrideStatus: "stable" as const,
      idempotencyKey: "correction-0001",
    };
    expect(appendStatusCorrectionRequestSchema.parse(valid).kind).toBe("status");
    expect(
      appendStatusCorrectionRequestSchema.safeParse({
        ...valid,
        workspaceId,
        ownerUserId: eventId,
      }).success,
    ).toBe(false);
  });
});
