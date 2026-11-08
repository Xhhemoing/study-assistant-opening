import { describe, expect, it, vi } from "vitest";
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
  const sql: SqlFn = async (parts, ..._values) => {
    const q = parts.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id FROM workspaces")) return [{ id: W }];
    if (q.startsWith("SELECT * FROM courses")) {
      return [courseRow(courseWs)];
    }
    if (q.startsWith("SELECT workspace_id FROM opening_sources")) {
      if (handlers.sourceWs == null) return [];
      return [{ workspace_id: handlers.sourceWs }];
    }
    if (q.startsWith("SELECT id FROM opening_sources")) {
      return handlers.sourceWs === W ? [{ id: S }] : [];
    }
    if (q.startsWith("INSERT INTO course_asset_memberships")) {
      return [
        {
          id: "00000000-0000-4000-8000-000000000010",
          workspace_id: W,
          course_id: C,
          asset_type: "source",
          asset_id: S,
          role: _values[4],
          sort_order: _values[5],
          visibility: _values[6],
          purpose: _values[7] ?? null,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
      ];
    }
    if (q.startsWith("DELETE FROM course_asset_memberships")) return [{ id: "00000000-0000-4000-8000-000000000010" }];
    throw new Error("Unexpected SQL in RU-01 probe: " + q);
  };
  return Object.assign(sql, {
    begin: <T>(callback: (tx: SqlFn) => Promise<T>) => callback(sql),
  });
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
      purpose: null,
    });
  });

  it.each(["teaching", "practice", "mock_exam", "reference"] as const)("preserves explicit %s purpose without changing role or visibility", async purpose => {
    const repo = createCourseMembershipRepository(makeSql({ sourceWs: W }) as never);
    const membership = await repo.addAssetMembership({
      workspaceId: W, courseId: C, assetType: "source", assetId: S,
      role: "optional", visibility: "private", purpose,
    });
    expect(membership.purpose).toBe(purpose);
    expect(membership).toMatchObject({ assetId: S, courseId: C, role: "optional", visibility: "private" });
  });

  it.each([
    { assetType: "document", purpose: "teaching" },
    { assetType: "source", purpose: "unknown" },
    { assetType: "source", purpose: "core" },
  ])("rejects invalid source purpose $assetType/$purpose before writing", async value => {
    const repo = createCourseMembershipRepository(makeSql({ sourceWs: W }) as never);
    await expect(repo.addAssetMembership({
      workspaceId: W, courseId: C, assetId: S, role: "core", visibility: "private", ...value,
    } as Parameters<typeof repo.addAssetMembership>[0])).rejects.toMatchObject({ code: "VALIDATION" });
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

describe("course purpose updates", () => {
  const identity = { workspaceId: W, courseId: C, assetType: "source" as const, assetId: S };
  const original = {
    id: "00000000-0000-4000-8000-000000000010", workspace_id: W, course_id: C,
    asset_type: "source", asset_id: S, role: "core", sort_order: 3,
    visibility: "private", purpose: "teaching", created_at: new Date(0), updated_at: new Date(0),
  };

  function updateSql(result: unknown[], exists = true) {
    const update = vi.fn((_values: unknown[]) => result);
    const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const q = parts.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("SELECT id FROM workspaces")) return [{ id: W }];
      if (q.startsWith("UPDATE course_asset_memberships")) return update(values);
      if (q.startsWith("SELECT id FROM course_asset_memberships")) return exists ? [{ id: original.id }] : [];
      throw new Error(`Unexpected SQL: ${q}`);
    }, { begin: <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => callback(sql) });
    return { sql, update };
  }

  it.each([undefined, "not-a-date", "2026-11-08"])("rejects missing/invalid expectedUpdatedAt %s without writing", async expectedUpdatedAt => {
    const { sql, update } = updateSql([]);
    const repo = createCourseMembershipRepository(sql as never);
    await expect(repo.updateAssetMembership({ ...identity, purpose: "mock_exam", expectedUpdatedAt }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(update).not.toHaveBeenCalled();
  });

  it.each(["mock_exam", null] as const)("changes only purpose to %s and returns the advanced timestamp", async purpose => {
    const { sql, update } = updateSql([{ ...original, purpose, updated_at: new Date(1) }]);
    const repo = createCourseMembershipRepository(sql as never);
    const membership = await repo.updateAssetMembership({ ...identity, purpose, expectedUpdatedAt: new Date(0).toISOString() });
    expect(membership).toMatchObject({ purpose, role: "core", sortOrder: 3, visibility: "private", updatedAt: new Date(1) });
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![0]).toContain(true);
    expect(update.mock.calls[0]![0]).toContain(purpose);
  });

  it.each([{ exists: true, code: "CONFLICT" }, { exists: false, code: "NOT_FOUND" }])("reports $code rather than pretending a stale/deleted membership was updated", async ({ exists, code }) => {
    const { sql } = updateSql([], exists);
    const repo = createCourseMembershipRepository(sql as never);
    await expect(repo.updateAssetMembership({ ...identity, purpose: "mock_exam", expectedUpdatedAt: new Date(0).toISOString() }))
      .rejects.toMatchObject({ code });
  });

  it("rejects non-source purpose updates before writing", async () => {
    const { sql, update } = updateSql([]);
    const repo = createCourseMembershipRepository(sql as never);
    await expect(repo.updateAssetMembership({ ...identity, assetType: "document", purpose: "teaching", expectedUpdatedAt: new Date(0).toISOString() }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(update).not.toHaveBeenCalled();
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
    expect(items[0]!.purpose).toBeNull();
    expect(items[0]!.source).toMatchObject({ id: S, workspaceId: W, uploadState: "uploaded" });
    expect(items[0]!.source).not.toHaveProperty("courseId");
  });
});
