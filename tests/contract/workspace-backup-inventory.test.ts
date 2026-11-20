import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backupSchemaManifestSchema, nativeBackupPackageSchema } from "@aistudy/contracts";
import { OPENING_RESTORE_APPLY_ORDER, validateOpeningRestore } from "@aistudy/domain";
import { BACKUP_FORBIDDEN_TABLES, EXPLICIT_NON_EXPORTED_WORKSPACE_TABLES, OPENING_BACKUP_TABLES,
  OPENING_RESTORE_NEVER_TABLES, OPENING_RESTORE_ROW_COLUMNS, executeOpeningRestoreApply,
  evaluateOpeningRestoreEmptyNamespace } from "@aistudy/database";
import { readOpeningBackupRecords } from "@aistudy/database";
import { NATIVE_BACKUP_TABLES } from "@aistudy/domain/native";
import { dumpWorkspaceSnapshot } from "../../packages/database/src/repositories/backup-dump";
import { createBackupRestoreRepository } from "../../packages/database/src/repositories/backup-restore";

const workspaceId = "a1000000-0000-4000-8000-000000000001";
const draft = { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0, deletionJournal: [], objects: [] };
const migrationDirectory = new URL("../../packages/database/src/migrations/", import.meta.url);

describe("learner backup inventory", () => {
  it("classifies every table introduced by migrations exactly once", () => {
    const tables = new Set<string>();
    for (const file of readdirSync(migrationDirectory).filter(name => name.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(file, migrationDirectory), "utf8").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
      const creates = [...sql.matchAll(/\bCREATE\s+(?:(?:UNLOGGED|TEMP(?:ORARY)?)\s+)?TABLE\s+/gi)];
      for (const match of creates) {
        const rest = sql.slice(match.index! + match[0].length);
        const table = /^(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"public"|public)\s*\.\s*)?(?:"([^"]+)"|([a-z_][\w$]*))(?=\s|\()/i.exec(rest);
        expect(table, file).toBeTruthy();
        tables.add(table![1] ?? table![2]!);
      }
    }
    const classified = [...OPENING_BACKUP_TABLES, ...BACKUP_FORBIDDEN_TABLES, ...EXPLICIT_NON_EXPORTED_WORKSPACE_TABLES];
    expect(new Set(classified).size).toBe(classified.length);
    // The wire also reserves this private namespace, which has no physical table.
    expect(new Set(classified)).toEqual(new Set([...tables, "opening_teaching_document_revisions"]));
    expect(new Set(OPENING_RESTORE_APPLY_ORDER)).toEqual(new Set(Object.keys(OPENING_RESTORE_ROW_COLUMNS)));
    expect(OPENING_RESTORE_NEVER_TABLES).toEqual(BACKUP_FORBIDDEN_TABLES);
  });

  it("keeps private supply, exposure and quota ledgers permanently forbidden", () => {
    for (const name of ["opening_course_reserved_questions", "opening_course_question_exposures", "opening_course_question_exposure_coverage",
      "opening_budget_reservations", "opening_budget_reconcile_events", "opening_parent_interaction_budgets"]) {
      expect(BACKUP_FORBIDDEN_TABLES).toContain(name);
    }
  });

  it("rejects a forbidden export inventory before opening either database reader", async () => {
    for (const [list, read] of [
      [OPENING_BACKUP_TABLES, () => readOpeningBackupRecords({} as never, { workspaceId, ownerUserId: workspaceId })],
      [NATIVE_BACKUP_TABLES, () => dumpWorkspaceSnapshot({} as never, workspaceId, workspaceId)],
    ] as const) {
      const inventory = list as unknown as string[];
      inventory.push("opening_course_reserved_questions");
      try { await expect(read()).rejects.toThrow(/Forbidden backup table/); }
      finally { inventory.pop(); }
    }
  });

  it.each(["available", "reserved", "issued", "revoked"])("refuses the entire private supply table including %s rows", async state => {
    const backup = { ...draft, tables: { opening_course_reserved_questions: [{ state, key_json: { answer: "private" } }] } };
    expect(validateOpeningRestore(backup, [])).toMatchObject({ allowed: false, recordCounts: {} });
    expect(await executeOpeningRestoreApply({} as never, { confirmLocalRestore: true, backup }))
      .toMatchObject({ ok: false, mutated: false, code: "PREFLIGHT_REJECTED" });
  });

  it("rejects even empty forbidden tables at the wire and repository boundaries", async () => {
    const counts = Object.fromEntries(OPENING_BACKUP_TABLES.map(table => [table, 0]));
    const manifest = { formatVersion: 1, latestMigrationId: "0111", workspaceSchemaVersion: 1, tables: ["workspaces"] };
    const records = { workspace: {}, ...Object.fromEntries(["courses","memberships","goals","windows","documents","blocks",
      "relations","revisions","explorations","promotions","cards","events"].map(key => [key, []])) };
    const packed = { format: "aistudy-native", sourceWorkspaceId: workspaceId, schemaManifest: manifest, records, files: [],
      counts: Object.fromEntries(["workspaces","courses","memberships","goals","windows","documents","blocks","relations","revisions",
        "explorations","promotions","cards","events","files"].map(key => [key, 0])) };
    expect(nativeBackupPackageSchema.safeParse(packed).success).toBe(true);
    expect(BACKUP_FORBIDDEN_TABLES).toContain("opening_teaching_document_revisions");
    for (const table of BACKUP_FORBIDDEN_TABLES) {
      expect(validateOpeningRestore({ ...draft, tables: { [table]: [] } }, []).allowed).toBe(false);
      expect(evaluateOpeningRestoreEmptyNamespace({ ...counts, [table]: 0 }).ok).toBe(false);
      expect(backupSchemaManifestSchema.safeParse({ ...manifest, tables: ["workspaces", table] }).success).toBe(false);
      const forbidden = { ...packed, records: { ...records, [table]: [] } };
      expect(nativeBackupPackageSchema.safeParse(forbidden).success).toBe(false);
      await expect(createBackupRestoreRepository({} as never).restoreWorkspace({ packed: forbidden } as never)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(validateOpeningRestore({ ...draft, tables: {} }, []).allowed).toBe(true);
  });
});
