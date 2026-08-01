import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createIdentityRepository,
  createSqlClient,
  createWorkspacePreferencesRepository,
  WorkspacePreferencesError,
} from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for workspace preference repository tests");
}

describe("workspace preference repository", () => {
  const sql = createSqlClient(databaseUrl);
  const identity = createIdentityRepository(sql);
  const preferences = createWorkspacePreferencesRepository(sql);
  let firstWorkspaceId: string;
  let secondWorkspaceId: string;

  beforeAll(async () => {
    await applyMigrations(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      workspace_preferences,
      course_asset_memberships,
      courses,
      library_properties,
      library_relations,
      library_revisions,
      library_blocks,
      library_documents,
      sessions,
      workspaces,
      users
      RESTART IDENTITY CASCADE`;

    const first = await identity.createUserWithWorkspace({
      email: `first-${randomUUID()}@example.com`,
      displayName: "First workspace",
      passwordHash: "not-used-in-this-test",
    });
    const second = await identity.createUserWithWorkspace({
      email: `second-${randomUUID()}@example.com`,
      displayName: "Second workspace",
      passwordHash: "not-used-in-this-test",
    });
    firstWorkspaceId = first.workspace.id;
    secondWorkspaceId = second.workspace.id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("returns null until a workspace selects a default entry", async () => {
    await expect(preferences.getDefaultEntry(firstWorkspaceId)).resolves.toBeNull();
  });

  it("upserts a workspace default entry", async () => {
    await expect(preferences.setDefaultEntry(firstWorkspaceId, "explore"))
      .resolves.toMatchObject({ workspaceId: firstWorkspaceId, defaultEntry: "explore" });
    await expect(preferences.setDefaultEntry(firstWorkspaceId, "library"))
      .resolves.toMatchObject({ workspaceId: firstWorkspaceId, defaultEntry: "library" });
    await expect(preferences.getDefaultEntry(firstWorkspaceId)).resolves.toBe("library");
  });

  it("keeps each workspace preference isolated", async () => {
    await preferences.setDefaultEntry(firstWorkspaceId, "explore");
    await preferences.setDefaultEntry(secondWorkspaceId, "library");

    await expect(preferences.getDefaultEntry(firstWorkspaceId)).resolves.toBe("explore");
    await expect(preferences.getDefaultEntry(secondWorkspaceId)).resolves.toBe("library");
  });

  it("rejects an invalid entry before persistence", async () => {
    await expect(
      preferences.setDefaultEntry(firstWorkspaceId, "invalid" as never),
    ).rejects.toMatchObject({ code: "VALIDATION" } satisfies Partial<WorkspacePreferencesError>);
  });

  it("rejects a preference for an unknown workspace", async () => {
    await expect(
      preferences.setDefaultEntry(randomUUID(), "learn"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<WorkspacePreferencesError>);
  });
});
