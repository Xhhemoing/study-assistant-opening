import { describe, expect, it } from "vitest";
import type { OpeningBackup } from "@aistudy/domain";
import { OPENING_RESTORE_APPLY_ORDER } from "@aistudy/domain";
import { OPENING_BACKUP_TABLES } from "./opening-backup-records";
import {
  createOpeningS3RestoreObjectPut,
  executeOpeningRestoreApply,
  OPENING_RESTORE_ROW_COLUMNS,
  parseOpeningRestoreObjectVersion,
} from "./opening-backup-apply";
import { normalizeOpeningImportedEvaluation } from "./opening-backup-evaluation";
import type { OpeningRestoreNamespaceCounts } from "./opening-backup-empty-namespace";

const workspaceId = "a1000000-0000-4000-8000-000000000001";
const sourceId = "c3000000-0000-4000-8000-000000000010";

function zeroCounts(): OpeningRestoreNamespaceCounts {
  return Object.fromEntries(OPENING_BACKUP_TABLES.map((t) => [t, 0])) as OpeningRestoreNamespaceCounts;
}

function draft(): OpeningBackup {
  return {
    format: "opening-backup",
    version: 1,
    workspaceId,
    privacyEpoch: 4,
    deletionJournal: [],
    tables: Object.fromEntries(OPENING_BACKUP_TABLES.map((name) => [
      name,
      name === "opening_sources"
        ? [{
            id: sourceId,
            workspace_id: workspaceId,
            name: "fixture.bin",
            mime: "application/octet-stream",
            bytes: 4,
            sha256: "ab".repeat(32),
            version: 1,
            upload_state: "uploaded",
            parse_state: "ready",
          }]
        : [],
    ])),
    objects: [{
      sourceId,
      sha256: "ab".repeat(32),
      bytes: 4,
      archivePath: `objects/${sourceId}/v1.bin`,
    }],
  };
}

describe("executeOpeningRestoreApply fail-closed gates", () => {
  it("refuses without confirmLocalRestore", async () => {
    const denied = await executeOpeningRestoreApply({} as never, {
      confirmLocalRestore: false as unknown as true,
      backup: draft(),
    });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("REQUIRES_EXPLICIT_CONFIRMATION");
    expect(denied.mutated).toBe(false);
    expect(denied.guarantees.pendingJobs).toBe("cancelled");
    expect(denied.guarantees.secretsRestored).toBe(false);
    expect(denied.guarantees.apiKeysRestored).toBe(false);
    expect(denied.guarantees.sessionsRestored).toBe(false);
  });

  it("rejects occupied emptyNamespaceCounts before opening a transaction", async () => {
    const occupied = zeroCounts();
    occupied.courses = 2;
    const result = await executeOpeningRestoreApply({} as never, {
      confirmLocalRestore: true,
      backup: draft(),
      currentDeletionJournal: [],
      emptyNamespaceCounts: occupied,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TARGET_NOT_EMPTY");
    expect(result.mutated).toBe(false);
    expect(result.emptyNamespaceVerified).toBe(false);
  });

  it("APPLY_ORDER columns cover every durable table and exclude never-tables", () => {
    expect(new Set(OPENING_RESTORE_APPLY_ORDER)).toEqual(new Set(OPENING_BACKUP_TABLES));
    expect(new Set(OPENING_RESTORE_APPLY_ORDER).size).toBe(OPENING_RESTORE_APPLY_ORDER.length);
    for (const table of OPENING_RESTORE_APPLY_ORDER) {
      expect(OPENING_RESTORE_ROW_COLUMNS[table].length).toBeGreaterThan(0);
      expect(["sessions", "opening_jobs", "opening_outbox", "opening_budget_reservations", "opening_source_visual_recognitions"]).not.toContain(table);
    }
  });

  it("preserves opening_tasks.client_key and retest accept keys on restore allowlist", () => {
    expect(OPENING_RESTORE_ROW_COLUMNS.opening_tasks).toContain("client_key");
    expect(OPENING_RESTORE_ROW_COLUMNS.opening_assistant_candidates).toEqual(
      expect.arrayContaining(["task_accept_client_key", "task_accept_intent", "task_result_ref"]),
    );
    expect(OPENING_RESTORE_ROW_COLUMNS.opening_plan_acceptances).toContain("client_key");
    expect(OPENING_RESTORE_ROW_COLUMNS.opening_plan_drafts).toContain("propose_client_key");
  });
});

describe("createOpeningS3RestoreObjectPut / parseOpeningRestoreObjectVersion", () => {
  it("parses version from archivePath and puts via finalKey", async () => {
    expect(parseOpeningRestoreObjectVersion(`objects/${sourceId}/v2.bin`, sourceId)).toBe(2);

    const puts: Array<{ key: string; body: Uint8Array }> = [];
    const storage = {
      finalKey: (id: string, version: number) => `opening/sources/${id}/v${version}`,
      async putObject(key: string, body: Uint8Array) {
        puts.push({ key, body });
      },
    };
    const objectPut = createOpeningS3RestoreObjectPut(storage);
    const body = new Uint8Array([9, 8, 7, 6]);
    await objectPut.put({
      sourceId,
      archivePath: `objects/${sourceId}/v2.bin`,
      sha256: "ab".repeat(32),
      bytes: 4,
      body,
    });
    expect(puts).toEqual([{ key: `opening/sources/${sourceId}/v2`, body }]);
    expect(objectPut.keys).toEqual([`opening/sources/${sourceId}/v2`]);
  });

  it("rejects unsafe or mismatched archivePath", () => {
    expect(() => parseOpeningRestoreObjectVersion("objects/../secret.bin", sourceId)).toThrow(/unsafe|match/);
    expect(() => parseOpeningRestoreObjectVersion(`objects/other/v1.bin`, sourceId)).toThrow(/match/);
  });
});


it("restores Study visibility metadata without admitting paid queues or proposal execution", () => {
  expect(OPENING_RESTORE_ROW_COLUMNS.opening_turns).toEqual(expect.arrayContaining(["context_anchor", "composer_purpose"]));
  expect(OPENING_RESTORE_ROW_COLUMNS.opening_learning_attempts).toContain("context_anchor");
  expect(OPENING_RESTORE_ROW_COLUMNS.opening_help_exposures).toEqual(expect.arrayContaining([
    "context_anchor", "release_key", "release_intent", "generated_at", "released_at", "acknowledged_at", "support_domain", "workspace_history_revision",
  ]));
  expect(OPENING_RESTORE_APPLY_ORDER).toEqual(expect.arrayContaining(["opening_learning_decisions", "opening_learning_shadow_predictions", "opening_study_intent_events"]));
  expect(OPENING_RESTORE_APPLY_ORDER).not.toContain("opening_parent_interaction_budgets");
  expect(OPENING_RESTORE_APPLY_ORDER).not.toContain("opening_assistant_proposals");
});

it("keeps new link provenance and replay history while restoring their behavior disabled", () => {
  expect(OPENING_RESTORE_ROW_COLUMNS.course_requirement_evidence_links).toEqual(expect.arrayContaining([
    "source_requirement_id", "source_requirement_revision", "target_requirement_id", "target_requirement_revision", "active", "revision",
  ]));
  expect(OPENING_RESTORE_ROW_COLUMNS.opening_learning_asset_links).toEqual(expect.arrayContaining([
    "asset_id", "asset_version", "origin_json", "source_refs", "status", "revision", "client_key", "create_intent",
  ]));
  const asset = { status: "active", origin_json: { sourceId }, source_refs: [{ sourceId, sourceVersion: 1 }], create_intent: { clientKey: "original" } };
  expect(normalizeOpeningImportedEvaluation("opening_learning_asset_links", asset)).toEqual({ ...asset, status: "detached" });
  expect(asset.status).toBe("active");
  const evidence = { active: true, source_requirement_revision: 3, target_requirement_revision: 4 };
  expect(normalizeOpeningImportedEvaluation("course_requirement_evidence_links", evidence)).toEqual({ ...evidence, active: false });
  expect(evidence.active).toBe(true);
});
