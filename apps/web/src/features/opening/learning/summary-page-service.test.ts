import { describe, expect, it } from "vitest";
import { parseCourseLearningSummaryRequest } from "./summary-page-service";
const courseId = "11111111-1111-4111-8111-111111111111";
describe("course summary query boundary", () => {
  it("defaults to ten groups while preserving an opaque cursor", () => {
    expect(parseCourseLearningSummaryRequest(courseId, new URLSearchParams())).toEqual({ courseId, limit: 10 });
    expect(parseCourseLearningSummaryRequest(courseId, new URLSearchParams({ groupCursor: "opaque+/= value", limit: "50" })))
      .toEqual({ courseId, groupCursor: "opaque+/= value", limit: 50 });
  });
  it.each(["limit=0", "limit=51", "limit=1.5", "limit=1&limit=2", "groupCursor=a&groupCursor=b", "ownerUserId=x", "groupCursor="])("rejects invalid or duplicate boundary input %s", query => {
    expect(() => parseCourseLearningSummaryRequest(courseId, new URLSearchParams(query))).toThrow();
  });
});
