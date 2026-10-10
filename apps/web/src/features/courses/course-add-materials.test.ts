import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { availableSourcesForCourse, CourseAddMaterials } from "./course-add-materials";
import type { CourseAsset } from "./course-model";

function source(id: string, name: string, uploadState: SourceRecord["uploadState"] = "uploaded"): SourceRecord {
  return {
    id,
    name,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    mime: "application/pdf",
    bytes: 1024,
    sha256: "ab".repeat(32),
    version: 0,
    uploadState,
    parseState: "ready",
    error: null,
    createdAt: "2026-10-03T01:00:00.000Z",
  };
}

describe("course add materials", () => {
  it("excludes sources already linked as course assets", () => {
    const linked = source("22222222-2222-4222-8222-222222222222", "linked.pdf");
    const free = source("33333333-3333-4333-8333-333333333333", "free.pdf");
    const assets: CourseAsset[] = [
      { id: "a1", assetType: "source", assetId: linked.id, role: "reference", sortOrder: 0, source: { id: linked.id, name: linked.name } },
    ];
    const available = availableSourcesForCourse([linked, free], assets);
    expect(available.map((item) => item.id)).toEqual([free.id]);
  });

  it("renders the add materials control closed by default", () => {
    const html = renderToStaticMarkup(createElement(CourseAddMaterials, {
      courseId: "11111111-1111-4111-8111-111111111111",
      assets: [],
      onAdded: () => {},
    }));
    expect(html).toContain("添加材料");
    expect(html).not.toContain("确认挂接");
  });
});

describe("course add materials memberships", () => {
  it("posts memberships for selected sources with default reference role", async () => {
    const courseId = "11111111-1111-4111-8111-111111111111";
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/opening/sources") && (!init || init.method === "GET" || !init.method)) {
        return new Response(JSON.stringify([source(sourceId, "lecture.pdf")]), { status: 200 });
      }
      if (href.includes(`/api/courses/${courseId}/memberships`) && init?.method === "POST") {
        return new Response(JSON.stringify({ membership: { id: "m1" } }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    const { createMaterialOrganizationClient } = await import("../opening/library/material-organization-client");
    const client = createMaterialOrganizationClient(fetcher);
    const result = await client.addToCourse(courseId, [sourceId], "reference");
    expect(result.succeeded).toEqual([sourceId]);
    expect(result.failed).toEqual([]);
    expect(JSON.parse(String(fetcher.mock.calls.find((call) => String(call[0]).includes("memberships"))?.[1]?.body))).toMatchObject({
      assetType: "source",
      assetId: sourceId,
      role: "reference",
    });
  });
});
