import { describe, expect, it, vi } from "vitest";
import { createCourseHistoryClient } from "./history-client";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";

const courseId = learningObservation.courseId;
const page = { observations: [learningObservation], snapshotRevision: 4, totalCount: 51, nextCursor: "opaque+/=", visibilityChanged: false };
describe("course history HTTP client", () => {
  it.each([{ input: {}, key: null, mode: null }, { input: { requirementKey: null }, key: null, mode: "unassigned" },
    { input: { requirementKey: "" }, key: "", mode: null }, { input: { requirementKey: " exact / key " }, key: " exact / key ", mode: null }])("serializes requirement scope without collapsing its identity: $input", async ({ input, key, mode }) => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = new URL(String(url), "http://localhost");
      expect(target.pathname).toBe(`/api/opening/courses/${courseId}/observations/history`);
      expect(target.searchParams.get("limit")).toBe("50");
      expect(target.searchParams.get("requirementKey")).toBe(key);
      expect(target.searchParams.get("requirement")).toBe(mode);
      return Response.json(page);
    });
    expect(await createCourseHistoryClient(fetchImpl).getHistory({ courseId, ...input })).toEqual(page);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("sends the server cursor unchanged and parses genuine empty pages", async () => {
    const empty = { ...page, observations: [], nextCursor: null, totalCount: 0 };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(new URL(String(url), "http://localhost").searchParams.get("cursor")).toBe(page.nextCursor);
      return Response.json(empty);
    });
    expect(await createCourseHistoryClient(fetchImpl).getHistory({ courseId, limit: 200, cursor: page.nextCursor })).toEqual(empty);
  });
  it.each([{ snapshotRevision: -1 }, { totalCount: 1.5 }, { observations: Array.from({ length: 201 }, () => learningObservation) },
    { observations: [{ ...learningObservation, id: "bad" }] }, { visibilityChanged: "false" }, { nextCursor: "" }])("rejects malformed server pages %j", async change => {
    await expect(createCourseHistoryClient(async () => Response.json({ ...page, ...change })).getHistory({ courseId })).rejects.toThrow();
  });
  it("keeps HTTP failures observable and never invents an empty page", async () => {
    const client = createCourseHistoryClient(async () => Response.json({ error: { code: "NOT_FOUND", message: "course unavailable" } }, { status: 404 }));
    await expect(client.getHistory({ courseId })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND", message: "course unavailable" });
  });
  it("rejects malformed successful JSON and oversized input before any invalid request", async () => {
    await expect(createCourseHistoryClient(async () => new Response("invalid", { status: 200 })).getHistory({ courseId })).rejects.toThrow();
    const fetchImpl = vi.fn();
    await expect(createCourseHistoryClient(fetchImpl).getHistory({ courseId, limit: 201 })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
