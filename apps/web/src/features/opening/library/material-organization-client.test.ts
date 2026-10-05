import { describe, expect, it, vi } from "vitest";
import { createMaterialOrganizationClient } from "./material-organization-client";
const course = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const ok = () => new Response(JSON.stringify({ membership: { id: course } }), { status: 201 });
describe("material organization client", () => {
  it("does not manufacture an empty organization on failed reads", async () => {
    const api = createMaterialOrganizationClient(async () => new Response("offline", { status: 503 }));
    await expect(api.read()).rejects.toThrow();
  });
  it("reuses existing memberships, adds private references and reports partial failure per source", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { assetId: string };
      return body.assetId === other ? new Response(JSON.stringify({ error: { message: "Source not found", code: "NOT_FOUND" } }), { status: 404 }) : ok();
    });
    const api = createMaterialOrganizationClient(fetcher);
    const result = await api.addToCourse(course, [source, source, other], "reference");
    expect(result.succeeded).toEqual([source]);
    expect(result.failed.map(item => item.id)).toEqual([other]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ assetType: "source", role: "reference", visibility: "private" });
    fetcher.mockClear();
    expect((await api.addToCourse(course, [source], "core")).succeeded).toEqual([source]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not trust a stale client-side membership as successful assignment", async () => {
    const api = createMaterialOrganizationClient(async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 }));
    const result = await api.addToCourse(course, [source], "reference");
    expect(result.succeeded).toEqual([]);
    expect(result.failed.map(item => item.id)).toEqual([source]);
  });
  it("verifies a conflict through the server instead of assuming it is a duplicate", async () => {
    const duplicate = createMaterialOrganizationClient(async (url) => String(url).includes("material-organization")
      ? new Response(JSON.stringify({ courses: [], memberships: [{ courseId: course, sourceId: source, role: "core" }] }))
      : new Response(JSON.stringify({ error: { code: "CONFLICT" } }), { status: 409 }));
    expect((await duplicate.addToCourse(course, [source], "core")).succeeded).toEqual([source]);
    const conflict = createMaterialOrganizationClient(async (url) => String(url).includes("material-organization")
      ? new Response(JSON.stringify({ courses: [], memberships: [] }))
      : new Response(JSON.stringify({ error: { code: "CONFLICT" } }), { status: 409 }));
    expect((await conflict.addToCourse(course, [source], "core")).failed).toHaveLength(1);
  });
  it("keeps a network-unknown result as a failure while continuing other materials", async () => {
    const api = createMaterialOrganizationClient(async (_url, init) => {
      if (JSON.parse(String(init?.body)).assetId === source) throw new Error("offline");
      return ok();
    });
    const result = await api.addToCourse(course, [source, other], "reference");
    expect(result.succeeded).toEqual([other]);
    expect(result.failed.map(item => item.id)).toEqual([source]);
  });
  it("removes only the course reference and preserves unexpected failure", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await createMaterialOrganizationClient(fetcher).removeFromCourse(course, [source]);
    expect(result.succeeded).toEqual([source]);
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(`/api/courses/${course}/memberships`, expect.objectContaining({ method: "DELETE" }));
  });
});
