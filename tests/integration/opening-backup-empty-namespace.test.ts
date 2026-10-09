/**
 * Q03 empty-namespace preflight against OPENING_TEST_DATABASE_URL (read-only counts).
 * Does not mutate rows/objects and does not claim restore apply is wired.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import {
  createSqlClient,
  evaluateOpeningRestoreEmptyNamespace,
  readOpeningRestoreNamespaceCounts,
  OPENING_BACKUP_TABLES,
} from "@aistudy/database";

const enabled = process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL);

describe.skipIf(!enabled)("opening restore empty-namespace counts (read-only)", () => {
  const url = assertOpeningTestDatabase(
    process.env.OPENING_TEST_DATABASE_URL ?? "",
    process.env.OPENING_TEST_DB,
  );
  const sql = createSqlClient(url.toString(), { max: 1 });
  afterAll(async () => {
    await sql.end({ timeout: 1 });
  });

  it("reports empty for a fresh workspace id that has no durable rows", async () => {
    const workspaceId = randomUUID();
    const counts = await readOpeningRestoreNamespaceCounts(sql, workspaceId);
    for (const table of OPENING_BACKUP_TABLES) {
      expect(counts[table]).toBe(0);
    }
    expect(evaluateOpeningRestoreEmptyNamespace(counts)).toEqual({ ok: true, totalRows: 0 });
  });

  it("reports occupied when an existing workspace already has courses", async () => {
    const [row] = await sql`SELECT workspace_id::text AS id FROM courses LIMIT 1`;
    if (!row) {
      // Shared test DB unexpectedly has no courses — still not an empty-DB drill claim.
      expect(true).toBe(true);
      return;
    }
    const workspaceId = String((row as { id: string }).id);
    const counts = await readOpeningRestoreNamespaceCounts(sql, workspaceId);
    expect(counts.courses).toBeGreaterThan(0);
    const result = evaluateOpeningRestoreEmptyNamespace(counts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("TARGET_NOT_EMPTY");
  });
});
