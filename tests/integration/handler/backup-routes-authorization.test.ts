import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST as createDocument } from "../../../apps/web/src/app/api/documents/route";
import { POST as exportBackup } from "../../../apps/web/src/app/api/backups/export/route";
import { POST as restoreBackup } from "../../../apps/web/src/app/api/backups/restore/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import type { NativeBackupPackage } from "@aistudy/contracts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for backup route authorization tests");
}

const cookieName = "aistudy_session";

function request(path: string, method: string, cookie?: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("backup routes authorization", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime> | undefined;

  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({
      databaseUrl,
      authSecret: "backup-handler-secret-at-least-32ch",
      sessionCookieSecure: false,
      sessionTtlSeconds: 3600,
      authCookieName: cookieName,
    });
    setAuthRuntimeForTests(runtime);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      learning_events, card_review_states, cards,
      promotion_targets, promotion_records,
      exploration_blocks, exploration_branches, explorations,
      revision_proposals, goal_time_windows, course_goals,
      course_asset_memberships, courses,
      library_properties, library_relations, library_revisions, library_blocks, library_documents,
      workspace_preferences, sessions, workspaces, users
      RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    setAuthRuntimeForTests(null);
    await runtime?.close();
    await sql.end({ timeout: 5 });
  });

  async function user(label: string) {
    const response = await register(
      request("/api/auth/register", "POST", undefined, {
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }),
    );
    const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
    return `${cookieName}=${token}`;
  }

  it("requires authentication and derives the target workspace from the session", async () => {
    expect((await exportBackup(request("/api/backups/export", "POST"))).status).toBe(401);
    expect((await restoreBackup(request("/api/backups/restore", "POST"))).status).toBe(401);

    const cookie = await user("owner");
    const created = await createDocument(request("/api/documents", "POST", cookie, {
      title: "导数笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "极限" } }],
    }));
    expect(created.status).toBe(201);
    const exported = await exportBackup(
      request("/api/backups/export", "POST", cookie, { workspaceId: randomUUID() }),
    );
    expect(exported.status).toBe(200);
    const body = await exported.json() as { format: string; package: NativeBackupPackage };
    expect(body.format).toBe("aistudy-native");
    expect(body.package.counts.documents).toBe(1);

    const conflicted = await restoreBackup(request("/api/backups/restore", "POST", cookie, {
      workspaceId: randomUUID(),
      conflictPolicy: "reject",
      package: body.package,
    }));
    expect(conflicted.status).toBe(409);
    expect(await conflicted.json()).toMatchObject({ error: { code: "CONFLICT" } });

    const restored = await restoreBackup(request("/api/backups/restore", "POST", cookie, {
      workspaceId: randomUUID(),
      conflictPolicy: "skip",
      package: body.package,
    }));
    expect(restored.status).toBe(200);
    const result = await restored.json() as { conflictPolicy: string; skipped: { documents: number } };
    expect(result.conflictPolicy).toBe("skip");
    expect(result.skipped.documents).toBe(1);
  });

  it("rejects foreign ids identically for both conflict policies without changing either workspace", async () => {
    const owner = await user("owner");
    const other = await user("other");
    const created = await createDocument(request("/api/documents", "POST", owner, {
      title: "私有笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "secret" } }],
    }));
    expect(created.status).toBe(201);
    const exported = await exportBackup(request("/api/backups/export", "POST", owner, {}));
    expect(exported.status).toBe(200);
    const body = await exported.json() as { package: NativeBackupPackage };
    expect(body.package.counts).toMatchObject({ documents: 1, blocks: 1 });
    const empty = await exportBackup(request("/api/backups/export", "POST", other, {}));
    expect(empty.status).toBe(200);
    const beforeOther = await empty.json() as { package: NativeBackupPackage };
    expect(beforeOther.package.counts).toMatchObject({ documents: 0, blocks: 0, revisions: 0 });

    for (const conflictPolicy of ["reject", "skip"] as const) {
      const denied = await restoreBackup(request("/api/backups/restore", "POST", other, {
        workspaceId: body.package.sourceWorkspaceId,
        conflictPolicy,
        package: body.package,
      }));
      // Foreign identities must not disclose an existence conflict or turn
      // `skip` into permission to import references owned by another workspace.
      expect(denied.status).toBe(400);
      expect(await denied.json()).toEqual({ error: {
        code: "VALIDATION", message: "Backup records conflict with the target workspace or contain invalid references",
      } });
      const ownerAfter = await exportBackup(request("/api/backups/export", "POST", owner, {}));
      const otherAfter = await exportBackup(request("/api/backups/export", "POST", other, {}));
      expect(ownerAfter.status).toBe(200);
      expect(otherAfter.status).toBe(200);
      expect(await ownerAfter.json()).toEqual(body);
      expect(await otherAfter.json()).toEqual(beforeOther);
    }
  });
});
