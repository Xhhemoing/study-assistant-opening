import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCourseMembershipRepository, createOpeningSourceRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

// Uses the real contiguous migration chain via createOpeningFixture. Do not
// inject a placeholder 0109, apply 0110 in isolation, or weaken migration guards.
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });

async function setup() {
  const courses = createCourseMembershipRepository(f.sql);
  const source = await createOpeningSourceRepository(f.sql).create(f.scope, {
    name: "purpose.pdf", mime: "application/pdf", bytes: 12, sha256: "a".repeat(64),
  });
  const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Purpose course", slug: randomUUID() });
  const input = { workspaceId: f.scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: source.id };
  const membership = await courses.addAssetMembership({ ...input, role: "optional", sortOrder: 7, visibility: "private" });
  return { courses, source, course, input, membership };
}

describe("course source purpose storage and concurrency", () => {
  it("retains unknown null and independently classifies one source in different courses", async () => {
    const { courses, source, input, membership } = await setup();
    expect(membership.purpose).toBeNull();
    const other = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Other purpose course", slug: randomUUID() });
    await courses.addAssetMembership({ ...input, courseId: other.id, purpose: "teaching", role: "core", visibility: "course" });
    const before = await f.sql`SELECT * FROM opening_sources WHERE id=${source.id}`;
    const updated = await courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt: membership.updatedAt.toISOString() });
    expect(updated).toMatchObject({ purpose: "mock_exam", role: "optional", visibility: "private", sortOrder: 7 });
    expect((await courses.getMembership({ ...input, courseId: other.id })).purpose).toBe("teaching");
    expect(await f.sql`SELECT * FROM opening_sources WHERE id=${source.id}`).toEqual(before);
    const cleared = await courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: updated.updatedAt.toISOString() });
    expect(cleared.purpose).toBeNull();
  });

  it("accepts the returned millisecond token for a legacy microsecond timestamp, then rejects its reuse", async () => {
    const { courses, input, membership } = await setup();
    await f.sql`UPDATE course_asset_memberships SET updated_at='2026-01-01T00:00:00.123456Z' WHERE id=${membership.id}`;
    const current = await courses.getMembership(input);
    const changed = await courses.updateAssetMembership({ ...input, purpose: "practice", expectedUpdatedAt: current.updatedAt.toISOString() });
    expect(changed.updatedAt.getTime()).toBeGreaterThan(current.updatedAt.getTime());
    await expect(courses.updateAssetMembership({ ...input, purpose: "reference", expectedUpdatedAt: current.updatedAt.toISOString() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await courses.getMembership(input)).purpose).toBe("practice");
  });

  it("allows exactly one concurrent purpose writer and preserves unrelated metadata changes", async () => {
    const { courses, input, membership } = await setup();
    const expectedUpdatedAt = membership.updatedAt.toISOString();
    const outcomes = await Promise.allSettled([
      courses.updateAssetMembership({ ...input, purpose: "teaching", expectedUpdatedAt }),
      courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    expect(failed).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    const current = await courses.getMembership(input);
    const metadata = await courses.updateAssetMembership({ ...input, role: "archive", sortOrder: 19 });
    expect(metadata).toMatchObject({ role: "archive", sortOrder: 19, visibility: "private", purpose: current.purpose });
    expect(metadata.updatedAt.getTime()).toBeGreaterThan(current.updatedAt.getTime());
    await expect(courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: current.updatedAt.toISOString() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enforces enum and source-only purpose in PostgreSQL, not just request parsing", async () => {
    const { membership } = await setup();
    await expect(f.sql`UPDATE course_asset_memberships SET purpose='unknown' WHERE id=${membership.id}`)
      .rejects.toMatchObject({ code: "23514" });
    await expect(f.sql`UPDATE course_asset_memberships SET asset_type='document',purpose='teaching' WHERE id=${membership.id}`)
      .rejects.toMatchObject({ code: "23514" });
    const [row] = await f.sql`SELECT asset_type,purpose FROM course_asset_memberships WHERE id=${membership.id}`;
    expect(row).toMatchObject({ asset_type: "source", purpose: null });
  });
});
