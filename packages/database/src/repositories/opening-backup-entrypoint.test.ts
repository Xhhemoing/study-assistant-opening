import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { OpeningBackup } from "@aistudy/domain";
import {
  applyOpeningRestore,
  publishOpeningBackupArchive,
  OpeningBackupExportError,
  OPENING_BACKUP_TABLES,
  OPENING_RESTORE_APPLY_ORDER,
  type OpeningRestoreNamespaceCounts,
} from "./opening-backup";
import {
  OPENING_RESTORE_ROW_COLUMNS,
} from "./opening-backup-apply";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opening-backup-entry-"));
  roots.push(directory);
  return directory;
}

const sourceId = "c3000000-0000-4000-8000-000000000010";
const workspaceId = "a1000000-0000-4000-8000-000000000001";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

describe("opening-backup entrypoint (Q03 thin wiring)", () => {
  it("applyOpeningRestore fails closed without confirm and with deferred executor", async () => {
    const denied = await applyOpeningRestore();
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("REQUIRES_EXPLICIT_CONFIRMATION");
    expect(denied.mutated).toBe(false);
    expect(denied.guarantees.secretsRestored).toBe(false);
    expect(denied.guarantees.pendingJobs).toBe("cancelled");

    const deferred = await applyOpeningRestore({ confirmLocalRestore: true });
    expect(deferred.ok).toBe(false);
    expect(deferred.code).toBe("APPLY_EXECUTOR_DEFERRED");
    expect(deferred.mutated).toBe(false);
    expect(deferred.guarantees.apiKeysRestored).toBe(false);
    expect(deferred.guarantees.sessionsRestored).toBe(false);
    expect(deferred.guarantees.pendingJobs).toBe("cancelled");
  });

  it("applyOpeningRestore dry-run requires backup and returns plan without mutating", async () => {
    const missing = await applyOpeningRestore({ confirmLocalRestore: true, dryRun: true });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("DRY_RUN_MISSING_BACKUP");
    expect(missing.mutated).toBe(false);
    expect(missing.mode).toBe("dry-run");
    expect(missing.guarantees.pendingJobs).toBe("cancelled");
    expect(missing.guarantees.secretsRestored).toBe(false);

    const tables = [
      "workspace_preferences", "courses", "course_asset_memberships",
      "opening_sources", "opening_source_chunks", "opening_conversations", "opening_turns",
      "opening_learning_sessions", "opening_problem_refs", "opening_help_exposures",
      "opening_learning_observations", "opening_assistant_candidates", "opening_memories",
      "opening_privacy_exclusions", "opening_tasks", "opening_retest_activities", "opening_timetable_sessions", "opening_hard_blocks",
      "opening_plan_state", "opening_plan_drafts", "opening_plan_acceptances",
      "opening_source_versions", "opening_learning_item_versions", "opening_learning_attempts", "opening_learning_history_revisions", "opening_workspace_history_revisions",
    ] as const;
    const draft: OpeningBackup = {
      format: "opening-backup",
      version: 1,
      workspaceId,
      privacyEpoch: 4,
      deletionJournal: [],
      tables: Object.fromEntries(tables.map((name) => [
        name,
        name === "opening_sources"
          ? [{ id: sourceId, workspace_id: workspaceId, version: 1, bytes: 4, sha256: "ab".repeat(32) }]
          : [],
      ])),
      objects: [{
        sourceId,
        sha256: "ab".repeat(32),
        bytes: 4,
        archivePath: `objects/${sourceId}/v1.bin`,
      }],
    };

    const dry = await applyOpeningRestore({
      confirmLocalRestore: true,
      dryRun: true,
      backup: draft,
      currentDeletionJournal: [],
    });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.code).toBe("DRY_RUN_OK");
    expect(dry.mode).toBe("dry-run");
    expect(dry.mutated).toBe(false);
    expect(dry.preview.allowed).toBe(true);
    expect(dry.preview.recordCounts.opening_sources).toBe(1);
    expect(dry.plan.objectCount).toBe(1);
    expect(dry.plan.batches.find((b) => b.table === "opening_sources")?.rows).toBe(1);
    expect(dry.guarantees.apiKeysRestored).toBe(false);
    expect(dry.guarantees.sessionsRestored).toBe(false);
    expect(dry.guarantees.secretsRestored).toBe(false);
    expect(dry.guarantees.pendingJobs).toBe("cancelled");
  });

  it("applyOpeningRestore dry-run surfaces preflight rejection with preview", async () => {
    const poisoned: OpeningBackup = {
      format: "opening-backup",
      version: 1,
      workspaceId,
      privacyEpoch: 4,
      deletionJournal: [],
      tables: {
        opening_memories: [{
          id: "33333333-3333-4333-8333-333333333333",
          workspace_id: workspaceId,
          status: "deleted",
          source_turn_ids: [sourceId],
        }],
      },
      objects: [],
    };
    const rejected = await applyOpeningRestore({
      confirmLocalRestore: true,
      dryRun: true,
      backup: poisoned,
      currentDeletionJournal: [],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.mutated).toBe(false);
    expect(rejected.mode).toBe("dry-run");
    expect(["PREFLIGHT_REJECTED", "JOURNAL_DRIFT"]).toContain(rejected.code);
    expect(rejected.guarantees.pendingJobs).toBe("cancelled");
    expect(rejected.preview).toBeDefined();
    expect(rejected.preview?.allowed).toBe(false);
  });

  function zeroCounts(): OpeningRestoreNamespaceCounts {
    return Object.fromEntries(OPENING_BACKUP_TABLES.map((t) => [t, 0])) as OpeningRestoreNamespaceCounts;
  }

  function minimalDraft(): OpeningBackup {
    const tables = OPENING_BACKUP_TABLES;
    return {
      format: "opening-backup",
      version: 1,
      workspaceId,
      privacyEpoch: 4,
      deletionJournal: [],
      tables: Object.fromEntries(tables.map((name) => [
        name,
        name === "opening_sources"
          ? [{ id: sourceId, workspace_id: workspaceId, version: 1, bytes: 4, sha256: "ab".repeat(32) }]
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

  it("confirm path rejects occupied namespace without mutating", async () => {
    const occupied = zeroCounts();
    occupied.courses = 1;
    const result = await applyOpeningRestore({
      confirmLocalRestore: true,
      backup: minimalDraft(),
      currentDeletionJournal: [],
      emptyNamespaceCounts: occupied,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TARGET_NOT_EMPTY");
    expect(result.mutated).toBe(false);
    expect(result.emptyNamespaceVerified).toBe(false);
    expect(result.guarantees.secretsRestored).toBe(false);
    expect(result.guarantees.pendingJobs).toBe("cancelled");
    expect(result.preview?.allowed).toBe(true);
    expect(result.plan?.objectCount).toBe(1);
  });

  it("confirm path verifies empty namespace then still defers without sql", async () => {
    const result = await applyOpeningRestore({
      confirmLocalRestore: true,
      backup: minimalDraft(),
      currentDeletionJournal: [],
      emptyNamespaceCounts: zeroCounts(),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("APPLY_EXECUTOR_DEFERRED");
    expect(result.mutated).toBe(false);
    expect(result.emptyNamespaceVerified).toBe(true);
    expect(result.guarantees.apiKeysRestored).toBe(false);
    expect(result.guarantees.sessionsRestored).toBe(false);
    expect(result.guarantees.pendingJobs).toBe("cancelled");
    expect(result.preview?.allowed).toBe(true);
    expect(result.plan?.batches.find((b) => b.table === "opening_sources")?.rows).toBe(1);
    expect(result.errors.join(" ")).toMatch(/empty-namespace verified/i);
    expect(result.errors.join(" ")).toMatch(/pass sql/i);
  });


  it("APPLY_ORDER allowlist never includes secrets/sessions/job tables", () => {
    for (const table of OPENING_RESTORE_APPLY_ORDER) {
      expect(table).not.toMatch(/session$|credential|opening_jobs|opening_outbox|budget/);
      expect(OPENING_RESTORE_ROW_COLUMNS[table]?.length).toBeGreaterThan(0);
    }
    expect(OPENING_RESTORE_APPLY_ORDER.indexOf("opening_sources"))
      .toBeLessThan(OPENING_RESTORE_APPLY_ORDER.indexOf("opening_source_chunks"));
  });


  it("dry-run stays mutated:false even when empty counts would pass", async () => {
    const dry = await applyOpeningRestore({
      confirmLocalRestore: true,
      dryRun: true,
      backup: minimalDraft(),
      currentDeletionJournal: [],
      emptyNamespaceCounts: zeroCounts(),
    });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.code).toBe("DRY_RUN_OK");
    expect(dry.mutated).toBe(false);
    expect(dry.guarantees.pendingJobs).toBe("cancelled");
  });

  it("publishOpeningBackupArchive fails closed when staging is incomplete", async () => {
    await expect(
      publishOpeningBackupArchive(
        {
          format: "opening-backup",
          version: 1,
          workspaceId,
          privacyEpoch: 1,
          deletionJournal: [],
          tables: {},
          objects: [],
        },
        "",
        "/tmp/out.opening",
      ),
    ).rejects.toMatchObject({ code: "STAGING_INCOMPLETE" });

    const directory = await scratch();
    const draft: OpeningBackup = {
      format: "opening-backup",
      version: 1,
      workspaceId,
      privacyEpoch: 1,
      deletionJournal: [],
      tables: {},
      objects: [
        {
          sourceId,
          sha256: hash("x"),
          bytes: 1,
          archivePath: `objects/${sourceId}/v1.bin`,
        },
      ],
    };
    await expect(
      publishOpeningBackupArchive(draft, directory, path.join(directory, "out.opening")),
    ).rejects.toBeInstanceOf(OpeningBackupExportError);
  });

  it("publishOpeningBackupArchive writes archive when staging is complete", async () => {
    const directory = await scratch();
    const staging = path.join(directory, "staging");
    await mkdir(path.join(staging, "objects", sourceId), { recursive: true });
    await writeFile(path.join(staging, "objects", sourceId, "v1.bin"), "abcd");
    const draft: OpeningBackup = {
      format: "opening-backup",
      version: 1,
      workspaceId,
      privacyEpoch: 4,
      deletionJournal: [],
      tables: { opening_sources: [{ id: sourceId, workspace_id: workspaceId }] },
      objects: [
        {
          sourceId,
          sha256: hash("abcd"),
          bytes: 4,
          archivePath: `objects/${sourceId}/v1.bin`,
        },
      ],
    };
    const destination = path.join(directory, "backup.opening");
    await publishOpeningBackupArchive(draft, staging, destination);
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(destination);
    expect(bytes.subarray(0, 17).toString("utf8")).toBe("OPENING-BACKUP-V1");
  });
});
