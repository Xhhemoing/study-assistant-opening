import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { OpeningBackupSourceError } from "./opening-backup-sources";
import { OpeningBackupCurrentError } from "./opening-backup-current";
import type { OpeningBackupRecordSnapshot } from "./opening-backup-records";
import type { OpeningSourceStaging } from "./opening-backup-prepare";

const boundary = vi.hoisted(() => {
  let actualRm: typeof import("node:fs/promises").rm = async () => undefined;
  const rmMock = vi.fn(async (...args: Parameters<typeof import("node:fs/promises").rm>) => actualRm(...args));
  return {
    rm: rmMock,
    setActual(next: typeof actualRm) {
      actualRm = next;
      rmMock.mockImplementation(async (...args) => actualRm(...args));
    },
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  boundary.setActual(actual.rm);
  return { ...actual, rm: boundary.rm };
});

vi.mock("./opening-backup-records", () => ({ readOpeningBackupRecords: vi.fn() }));
vi.mock("./opening-backup-prepare", () => ({ prepareOpeningSourceBackup: vi.fn() }));

const { assembleOpeningBackupDraft } = await import("./opening-backup-compose");
const readRecords = vi.mocked((await import("./opening-backup-records")).readOpeningBackupRecords);
const prepare = vi.mocked((await import("./opening-backup-prepare")).prepareOpeningSourceBackup);

const workspaceId = "a1000000-0000-4000-8000-000000000001";
const ownerUserId = "b2000000-0000-4000-8000-0000000000aa";
const sourceId = "c3000000-0000-4000-8000-000000000010";
const excludedId = "d4000000-0000-4000-8000-000000000020";
const hash = "ab".repeat(32);
const sql = {} as Sql;
const tables = [
  "opening_sources", "opening_source_chunks", "opening_conversations", "opening_turns",
  "opening_learning_sessions", "opening_problem_refs", "opening_help_exposures",
  "opening_learning_observations", "opening_assistant_candidates", "opening_memories",
  "opening_privacy_exclusions", "opening_tasks", "opening_retest_activities", "opening_timetable_sessions", "opening_hard_blocks",
  "opening_plan_state", "opening_plan_drafts", "opening_plan_acceptances",
  "opening_source_versions", "opening_learning_item_versions", "opening_learning_attempts", "opening_learning_history_revisions",
] as const;
const roots: string[] = [];

function recordsSnapshot(): OpeningBackupRecordSnapshot {
  return {
    privacyEpoch: 4,
    deletionJournal: [],
    tables: Object.fromEntries(tables.map((name) => [name, name === "opening_sources"
      ? [{ id: sourceId, workspace_id: workspaceId, version: 1, bytes: 4, sha256: hash }]
      : []])) as unknown as OpeningBackupRecordSnapshot["tables"],
  };
}

function staged(name: string): OpeningSourceStaging {
  return {
    directory: path.join(roots[roots.length - 1]!, name),
    snapshot: {
      workspaceId, privacyEpoch: 4, deletionJournal: [],
      sources: [{ sourceId, version: 1, bytes: 4, sha256: hash }],
    },
    objects: [{ sourceId, sha256: hash, bytes: 4, archivePath: `objects/${sourceId}/v1.bin`, actualSha256: hash }],
  };
}

/** Creates the staged directory for real so cleanup paths exercise actual removal. */
async function stagedOnDisk(name: string): Promise<OpeningSourceStaging> {
  const staging = staged(name);
  await mkdir(staging.directory, { recursive: true });
  await writeFile(path.join(staging.directory, "objects.bin"), "abcd");
  return staging;
}

async function parent(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opening-compose-"));
  roots.push(directory);
  await writeFile(path.join(directory, "sentinel"), "keep");
  return directory;
}

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  boundary.setActual(actual.rm);
  await Promise.all(roots.splice(0).map((directory) => actual.rm(directory, { recursive: true, force: true })));
});

describe("assembleOpeningBackupDraft", () => {
  beforeEach(() => {
    readRecords.mockReset();
    prepare.mockReset();
  });

  it("reads records first, then stages, and returns a caller-owned draft", async () => {
    const root = await parent();
    const order: string[] = [];
    const staging = await stagedOnDisk("opening-backup-ok");
    readRecords.mockImplementation(async () => {
      order.push("records");
      return recordsSnapshot();
    });
    prepare.mockImplementation(async () => {
      order.push("prepare");
      return staging;
    });

    const result = await assembleOpeningBackupDraft(sql, { workspaceId, ownerUserId }, root, {} as never);

    expect(order).toEqual(["records", "prepare"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backup).toMatchObject({ format: "opening-backup", version: 1, workspaceId, privacyEpoch: 4 });
    expect(result.backup.objects[0]).not.toHaveProperty("actualSha256");
    expect(readRecords).toHaveBeenCalledWith(sql, { workspaceId, ownerUserId });
    expect(await readdir(root)).toEqual(expect.arrayContaining(["sentinel", "opening-backup-ok"]));
  });

  it("does not stage when the owner gate rejects and propagates NOT_FOUND", async () => {
    const root = await parent();
    readRecords.mockRejectedValue(new OpeningBackupSourceError());

    await expect(assembleOpeningBackupDraft(sql, { workspaceId, ownerUserId }, root, {} as never))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("propagates the recheck conflict without owning cleanup", async () => {
    const root = await parent();
    const conflict = new OpeningBackupCurrentError();
    readRecords.mockResolvedValue(recordsSnapshot());
    prepare.mockRejectedValue(conflict);

    await expect(assembleOpeningBackupDraft(sql, { workspaceId, ownerUserId }, root, {} as never))
      .rejects.toBe(conflict);
  });

  it("removes the staging directory and reports JOURNAL_MISMATCH on divergence", async () => {
    const root = await parent();
    const mark = { sourceId: excludedId, deletedAt: "2026-09-21T00:00:00.000Z" };
    const records = recordsSnapshot();
    records.deletionJournal = [mark];
    (records.tables.opening_privacy_exclusions as unknown[]).push({
      id: "e5000000-0000-4000-8000-000000000030",
      workspace_id: workspaceId, source_id: excludedId, deleted_at: mark.deletedAt,
    });
    readRecords.mockResolvedValue(records);
    prepare.mockImplementation(async () => stagedOnDisk("opening-backup-diverged").then((value) => {
      roots.push(value.directory);
      return value;
    }));

    const result = await assembleOpeningBackupDraft(sql, { workspaceId, ownerUserId }, root, {} as never);

    expect(result).toMatchObject({ ok: false, code: "JOURNAL_MISMATCH" });
    expect(await readdir(root)).toEqual(["sentinel"]);
  });

  it("surfaces cleanup failure instead of a misleading compose result", async () => {
    const root = await parent();
    const records = recordsSnapshot();
    records.deletionJournal = [{ sourceId: excludedId, deletedAt: "2026-09-21T00:00:00.000Z" }];
    readRecords.mockResolvedValue(records);
    prepare.mockImplementation(async () => stagedOnDisk("opening-backup-stuck"));

    boundary.rm.mockImplementation(async (target, options) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      if (path.basename(String(target)).startsWith("opening-backup-")) {
        throw new Error("EPERM secret=super-secret-value");
      }
      return actual.rm(target, options);
    });

    const error = await assembleOpeningBackupDraft(sql, { workspaceId, ownerUserId }, root, {} as never)
      .then(() => {
        throw new Error("expected cleanup failure");
      }, (caught: unknown) => caught);
    expect((error as Error).message).toMatch(/cleanup failed/i);
    expect((error as Error).message).not.toMatch(/secret|super-secret/i);
  });

  it("uses the copied scope for both reads when the caller mutates it", async () => {
    const root = await parent();
    const mutable = { workspaceId, ownerUserId };
    const staging = await stagedOnDisk("opening-backup-scope");
    readRecords.mockResolvedValue(recordsSnapshot());
    prepare.mockResolvedValue(staging);

    const pending = assembleOpeningBackupDraft(sql, mutable, root, {} as never);
    mutable.workspaceId = "f6000000-0000-4000-8000-000000000099";
    await pending;

    expect(readRecords).toHaveBeenCalledWith(sql, { workspaceId, ownerUserId });
    expect(prepare).toHaveBeenCalledWith(sql, { workspaceId, ownerUserId }, root, expect.anything());
  });
});
