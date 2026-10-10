import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import {
  MAX_ASSISTANT_SOURCE_IDS,
  addSelectedSourceIds,
  hasReadyMembershipMaterials,
  membershipSourceIdsForCourse,
  parseAssistantCourseIdParam,
  resolveAssistantCourseId,
  toggleSelectedSourceId,
} from "./course-source-selection";

const COURSE = "11111111-1111-4111-8111-111111111111";
const S1 = "22222222-2222-4222-8222-222222222222";
const S2 = "33333333-3333-4333-8333-333333333333";
const S3 = "44444444-4444-4444-8444-444444444444";
const WS = "55555555-5555-4555-8555-555555555555";

function source(id: string, ready = true): SourceRecord {
  return {
    id,
    workspaceId: WS,
    name: `${id}.pdf`,
    mime: "application/pdf",
    bytes: 1,
    sha256: "ab".repeat(32),
    version: 0,
    uploadState: "uploaded",
    parseState: ready ? "ready" : "queued",
    error: null,
    createdAt: "2026-10-10T00:00:00.000Z",
  };
}

describe("parseAssistantCourseIdParam", () => {
  it("accepts UUIDs and rejects junk", () => {
    expect(parseAssistantCourseIdParam(COURSE)).toBe(COURSE);
    expect(parseAssistantCourseIdParam("not-a-uuid")).toBeNull();
    expect(parseAssistantCourseIdParam(undefined)).toBeNull();
  });
});

describe("resolveAssistantCourseId", () => {
  it("prefers learningAttempt, then resume, then query/shell", () => {
    expect(resolveAssistantCourseId({
      learningAttemptCourseId: COURSE,
      resumeCourseId: S1,
      initialCourseId: S2,
    })).toBe(COURSE);
    expect(resolveAssistantCourseId({
      resumeCourseId: S1,
      initialCourseId: S2,
    })).toBe(S1);
    expect(resolveAssistantCourseId({ initialCourseId: S2 })).toBe(S2);
    expect(resolveAssistantCourseId({})).toBeNull();
  });
});

describe("membership-default picker helpers", () => {
  it("collects membership source ids for a course", () => {
    const org = {
      courses: [{ id: COURSE, title: "微积分", archived: false }],
      memberships: [
        { courseId: COURSE, sourceId: S1, role: "core" },
        { courseId: COURSE, sourceId: S2, role: "reference" },
        { courseId: S3, sourceId: S3, role: "core" },
      ],
    };
    expect([...membershipSourceIdsForCourse(org, COURSE)].sort()).toEqual([S1, S2].sort());
    expect(membershipSourceIdsForCourse(org, null).size).toBe(0);
  });

  it("detects ready membership materials only", () => {
    const ids = new Set([S1, S2]);
    expect(hasReadyMembershipMaterials([source(S1), source(S2, false), source(S3)], ids)).toBe(true);
    expect(hasReadyMembershipMaterials([source(S1, false), source(S3)], ids)).toBe(false);
  });
});

describe("selection cap and upload auto-select", () => {
  it("auto-adds uploaded ids without duplicates up to 32", () => {
    expect(addSelectedSourceIds([S1], [S1, S2])).toEqual([S1, S2]);
    const filled = Array.from({ length: MAX_ASSISTANT_SOURCE_IDS }, (_, i) =>
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
    );
    expect(addSelectedSourceIds(filled, [S1])).toHaveLength(MAX_ASSISTANT_SOURCE_IDS);
  });

  it("toggles with cap", () => {
    expect(toggleSelectedSourceId([S1], S1)).toEqual([]);
    expect(toggleSelectedSourceId([S1], S2)).toEqual([S1, S2]);
    const filled = Array.from({ length: MAX_ASSISTANT_SOURCE_IDS }, (_, i) =>
      `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
    );
    expect(toggleSelectedSourceId(filled, S1)).toEqual(filled);
  });
});
