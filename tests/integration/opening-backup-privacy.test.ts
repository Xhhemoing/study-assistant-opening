/**
 * Q03 Create-list gate (08-delivery.md § Q03).
 * Red until packages/database/src/repositories/opening-backup.ts exports
 * exportOpeningBackup for packaging / Q01. Domain validateOpeningRestore cases
 * stay fail-closed here so this path is what Q01 modifies.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "@aistudy/domain";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKUP_ENTRY = path.join(ROOT, "packages/database/src/repositories/opening-backup.ts");

const SOURCE = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const FOREIGN_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMORY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TURN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONVERSATION = "88888888-8888-4888-8888-888888888888";
const CANDIDATE = "99999999-9999-4999-8999-999999999999";
const TASK = "55555555-5555-4555-8555-555555555555";

function backup(overrides: Partial<OpeningBackup> = {}): OpeningBackup {
  return {
    format: "opening-backup",
    version: 1,
    workspaceId: WORKSPACE,
    privacyEpoch: 4,
    deletionJournal: [],
    tables: {
      opening_sources: [{ id: SOURCE, workspace_id: WORKSPACE, version: 1, bytes: 12, sha256: "ab".repeat(32) }],
    },
    objects: [{ sourceId: SOURCE, sha256: "ab".repeat(32), bytes: 12, archivePath: "objects/a.bin" }],
    ...overrides,
  };
}

describe("opening-backup-privacy (Q03 Create-list)", () => {
  it("requires packages/database opening-backup repository entrypoint with exportOpeningBackup", async () => {
    expect(existsSync(BACKUP_ENTRY)).toBe(true);
    const mod = await import("../../packages/database/src/repositories/opening-backup");
    expect(typeof (mod as { exportOpeningBackup?: unknown }).exportOpeningBackup).toBe("function");
  });

  it("rejects restored deleted-memory payloads", () => {
    const withStatus = validateOpeningRestore(
      backup({
        tables: {
          opening_sources: [],
          opening_turns: [{
            id: TURN,
            workspace_id: WORKSPACE,
            role: "assistant",
            context_source_refs: [],
            source_ids: [],
            citations: [],
          }],
          opening_memories: [{
            id: MEMORY,
            workspace_id: WORKSPACE,
            owner_user_id: OWNER,
            status: "deleted",
            source_turn_ids: [TURN],
          }],
        },
        objects: [],
      }),
      [],
      { workspaceId: WORKSPACE, memories: [] },
    );
    expect(withStatus.allowed).toBe(false);
    expect(withStatus.errors.join(" ")).toMatch(/deleted memory/i);

    const overlay = validateOpeningRestore(
      backup({
        tables: {
          opening_sources: [],
          opening_turns: [{
            id: TURN,
            workspace_id: WORKSPACE,
            role: "assistant",
            context_source_refs: [],
            source_ids: [],
            citations: [],
          }],
          opening_memories: [{
            id: MEMORY,
            workspace_id: WORKSPACE,
            owner_user_id: OWNER,
            status: "active",
            source_turn_ids: [TURN],
          }],
        },
        objects: [],
      }),
      [],
      {
        workspaceId: WORKSPACE,
        memories: [{ memoryId: MEMORY, deletedAt: "2026-09-24T00:00:00.000Z" }],
      },
    );
    expect(overlay.allowed).toBe(false);
    expect(overlay.errors.join(" ")).toMatch(/deleted memory/i);
  });

  it("rejects wrong source hash and unknown backup version", () => {
    const wrongHash = validateOpeningRestore(
      backup({
        objects: [{
          sourceId: SOURCE,
          sha256: "cd".repeat(32),
          bytes: 12,
          archivePath: "objects/a.bin",
          actualSha256: "ab".repeat(32),
        }],
      }),
      [],
    );
    expect(wrongHash.allowed).toBe(false);
    expect(wrongHash.errors.join(" ")).toMatch(/hash/i);

    const unknown = validateOpeningRestore({ ...backup(), version: 2 }, []);
    expect(unknown.allowed).toBe(false);
    expect(unknown.errors.join(" ")).toMatch(/version/i);
  });

  it("rejects non-owner access via foreign-owner candidate lineage", () => {
    const foreign = validateOpeningRestore(
      backup({
        tables: {
          opening_sources: [{ id: SOURCE, workspace_id: WORKSPACE, version: 1, bytes: 12, sha256: "ab".repeat(32) }],
          opening_conversations: [{ id: CONVERSATION, workspace_id: WORKSPACE, owner_user_id: FOREIGN_OWNER }],
          opening_turns: [{
            id: TURN,
            workspace_id: WORKSPACE,
            conversation_id: CONVERSATION,
            role: "assistant",
            context_source_refs: [],
          }],
          opening_assistant_candidates: [{
            id: CANDIDATE,
            workspace_id: WORKSPACE,
            conversation_id: CONVERSATION,
            source_turn_id: TURN,
            source_ids: [],
            payload: {},
            status: "accepted",
          }],
          opening_tasks: [{
            id: TASK,
            workspace_id: WORKSPACE,
            owner_user_id: OWNER,
            candidate_id: CANDIDATE,
          }],
        },
      }),
      [],
    );
    expect(foreign.allowed).toBe(false);
    expect(foreign.errors.join(" ")).toMatch(/candidate.*owner|owner.*candidate/i);
  });
});
