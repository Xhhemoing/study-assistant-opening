import { describe, expect, it } from "vitest";
import {
  CourseMembershipError,
  createCourseMembershipRepository,
} from "./course-membership";

const W = "00000000-0000-4000-8000-000000000001";
const W2 = "00000000-0000-4000-8000-000000000099";
const C = "00000000-0000-4000-8000-000000000002";
const S = "00000000-0000-4000-8000-000000000003";

type SqlFn = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
};

function courseRow(workspaceId: string) {
  return {
    id: C,
    workspace_id: workspaceId,
    title: "Synthetic mathematics",
    slug: "synthetic-math",
    description: "",
    schema_version: 1,
    created_at: new Date(0),
    updated_at: new Date(0),
    archived_at: null,
  };
}

function makeSql(handlers: {
  sourceWs?: string | null;
  courseWs?: string;
}): SqlFn {
  const courseWs = handlers.courseWs ?? W;
  return async (parts, ..._values) => {
    const q = parts.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id FROM workspaces")) return [{ id: W }];
    if (q.startsWith("SELECT * FROM courses")) {
      return [courseRow(courseWs)];
    }
    if (q.startsWith("SELECT workspace_id FROM opening_sources")) {
      if (handlers.sourceWs == null) return [];
      return [{ workspace_id: handlers.sourceWs }];
    }
    if (q.startsWith("INSERT INTO course_asset_memberships")) {
      return [
        {
          id: "00000000-0000-4000-8000-000000000010",
          workspace_id: W,
          course_id: C,
          asset_type: "source",
          asset_id: S,
          role: "core",
          sort_order: 0,
          visibility: "private",
          created_at: new Date(0),
          updated_at: new Date(0),
        },
      ];
    }
    if (q.startsWith("DELETE FROM course_asset_memberships")) return [{ id: "00000000-0000-4000-8000-000000000010" }];
    throw new Error("Unexpected SQL in RU-01 probe: " + q);
  };
}

describe("course membership source resolver (RU-01)", () => {
  it("links a same-workspace source without VALIDATION", async () => {
    const repo = createCourseMembershipRepository(makeSql({ sourceWs: W }) as never);
    const membership = await repo.addAssetMembership({
      workspaceId: W,
      courseId: C,
      assetType: "source",
      assetId: S,
      role: "core",
      visibility: "private",
    });
    expect(membership).toMatchObject({
      assetType: "source",
      assetId: S,
      courseId: C,
      workspaceId: W,
    });
  });

  it("rejects cross-workspace source attach", async () => {
    const repo = createCourseMembershipRepository(
      makeSql({ sourceWs: W2 }) as never,
    );
    await expect(
      repo.addAssetMembership({
        workspaceId: W,
        courseId: C,
        assetType: "source",
        assetId: S,
        role: "core",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      name: "CourseMembershipError",
      code: "CROSS_WORKSPACE_REFERENCE",
    });
  });

  it("still rejects practice-item as not membership-backed", async () => {
    const repo = createCourseMembershipRepository(makeSql({ sourceWs: W }) as never);
    await expect(
      repo.addAssetMembership({
        workspaceId: W,
        courseId: C,
        assetType: "practice-item",
        assetId: S,
        role: "core",
        visibility: "private",
      }),
    ).rejects.toBeInstanceOf(CourseMembershipError);
    await expect(
      repo.addAssetMembership({
        workspaceId: W,
        courseId: C,
        assetType: "practice-item",
        assetId: S,
        role: "core",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Asset type not yet membership-backed: practice-item",
    });
  });

  it("removes a source membership (revoke)", async () => {
    const repo = createCourseMembershipRepository(makeSql({ sourceWs: W }) as never);
    await expect(
      repo.removeAssetMembership({
        workspaceId: W,
        courseId: C,
        assetType: "source",
        assetId: S,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("course read projection for source membership", () => {
  it("listCourseAssets attaches source without courseId", async () => {
    const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const q = parts.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("SELECT * FROM courses")) {
        return [{
          id: C, workspace_id: W, title: "Synthetic mathematics", slug: "synthetic-math",
          description: "", schema_version: 1, created_at: new Date(0), updated_at: new Date(0), archived_at: null,
        }];
      }
      if (q.startsWith("SELECT * FROM course_asset_memberships")) {
        return [{
          id: "00000000-0000-4000-8000-000000000010",
          workspace_id: W, course_id: C, asset_type: "source", asset_id: S,
          role: "core", sort_order: 0, visibility: "course",
          created_at: new Date(0), updated_at: new Date(0),
        }];
      }
      if (q.startsWith("SELECT * FROM opening_sources")) {
        return [{
          id: S, workspace_id: W, name: "a.pdf", mime: "application/pdf", bytes: 12,
          sha256: "a".repeat(64), version: 0, upload_state: "uploaded", parse_state: "not_started",
          error: null, created_at: new Date("2026-09-13T00:00:00.000Z"),
          updated_at: new Date("2026-09-13T00:00:00.000Z"),
        }];
      }
      throw new Error("Unexpected SQL in projection probe: " + q + " values=" + JSON.stringify(values));
    };
    const repo = createCourseMembershipRepository(sql as never);
    const items = await repo.listCourseAssets({ workspaceId: W, courseId: C });
    expect(items).toHaveLength(1);
    expect(items[0]!.assetType).toBe("source");
    expect(items[0]!.source).toMatchObject({ id: S, workspaceId: W, uploadState: "uploaded" });
    expect(items[0]!.source).not.toHaveProperty("courseId");
  });
});
