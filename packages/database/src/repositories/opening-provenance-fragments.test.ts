import type { Sql, TransactionSql } from "postgres";
import { expect, it } from "vitest";
import { cardReadable } from "./card-sources";
import { includedProblem, includedTurn } from "./opening-backup-record-predicates";
import { contextSourceRefsIncluded, memoryTransitiveDependenciesActive, noteContextSourceRefs, turnContextSourceRefs } from "./opening-context-provenance";
import { createOpeningMemoryRepository } from "./opening-memory";
import { confirmOwnedMemory } from "./opening-memory-decision";
import { replaceOwnedMemory } from "./opening-memory-replace";
import { insertOpeningTaskWithOutcome } from "./opening-retest-task";
import { admitTaskCandidate } from "./opening-task-candidate-admission";

import { openingWritingActivityReadableSql } from "./opening-writing-read-target";
type Row = Record<string, unknown>;

/** Enforce this repository's fresh-fragment convention independently of driver behavior. */
function strictSql(execute: (query: string) => Row[]) {
  return {
    async begin(work: (tx: TransactionSql) => Promise<unknown>) {
      class PendingQuery {
        consumed = false;
        constructor(readonly text: string) {}
        consume() {
          if (this.consumed) throw new Error("Reused SQL fragment: " + this.text);
          this.consumed = true;
          return this.text;
        }
        then(resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(() => execute(this.consume())).then(resolve, reject);
        }
      }
      const created: PendingQuery[] = [];
      const pending = (text: string) => {
        const query = new PendingQuery(text.replace(/\s+/g, " ").trim());
        created.push(query);
        return query;
      };
      const tx = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => pending(
        strings.reduce((text, part, index) => {
          const value = values[index - 1];
          return text + (index === 0 ? "" : value instanceof PendingQuery ? value.consume() : "?") + part;
        }, ""),
      ), { unsafe: pending, json: JSON.stringify });
      const result = await work(tx as unknown as TransactionSql);
      const unused = created.find(q => !q.consumed);
      if (unused) throw new Error("Unused SQL fragment: " + unused.text);
      return result;
    },
  } as unknown as Sql;
}

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const turnId = "33333333-3333-4333-8333-333333333333";
const memoryId = "44444444-4444-4444-8444-444444444444";
const candidateId = "55555555-5555-4555-8555-555555555555";
const taskId = "66666666-6666-4666-8666-666666666666";

it("proposes, confirms and replaces turn-backed memories with fresh fragments", async () => {
  const timestamp = "2026-11-21T10:00:00.000Z";
  const memory = { id: memoryId, workspace_id: scope.workspaceId, kind: "candidate", text: "Use a diagram",
    source_turn_ids: [turnId], status: "active", version: 0, created_at: timestamp, updated_at: timestamp };
  const sql = strictSql(query => {
    if (query.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (query.startsWith("UPDATE workspaces SET privacy_epoch")) return [{ id: scope.workspaceId, privacy_epoch: 1 }];
    if (query.includes("opening_workspace_history_revisions") || query.startsWith("UPDATE opening_tutor_jobs")) return [];
    if (query.startsWith("SELECT t.id FROM opening_turns")) return [{ id: turnId }];
    if (query.startsWith("SELECT m.id,")) return [{ id: memoryId, ancestor_temporary_expires_at: null }];
    if (query.startsWith("SELECT source_turn_ids, text") || query.startsWith("SELECT * FROM opening_memories WHERE workspace_id")) return [];
    if (query.startsWith("SELECT * FROM opening_memories WHERE id")) return [memory];
    if (query.startsWith("INSERT INTO opening_memories")) return [memory];
    if (query.startsWith("UPDATE opening_memories SET kind")) {
      Object.assign(memory, { kind: "confirmed", version: 1 });
      return [memory];
    }
    if (query.startsWith("UPDATE opening_memories SET status")) {
      Object.assign(memory, { text: "Draw a diagram first", version: 2 });
      return [memory];
    }
    throw new Error(query);
  });
  const input = { text: memory.text, sourceTurnIds: [turnId], expiresAt: null };
  const proposed = await createOpeningMemoryRepository(sql).proposeMemory(scope, input);
  expect(proposed).toMatchObject({ kind: "candidate", version: 0 });
  const confirmed = await confirmOwnedMemory(sql, scope, proposed.id, proposed.version, "confirm-fragments");
  expect(confirmed).toMatchObject({ kind: "confirmed", version: 1 });
  const revised = await replaceOwnedMemory(sql, scope, {
    id: confirmed.id, expectedVersion: confirmed.version, text: "Draw a diagram first", sourceTurnIds: [turnId],
    clientKey: "replace-fragments",
  });
  expect(revised).toMatchObject({ kind: "confirmed", version: 2, text: "Draw a diagram first" });
});

it("admits and accepts a task candidate with ancestry using fresh fragments", async () => {
  const payload = { kind: "task", title: "Practice", minutes: 15, dueText: null };
  const sql = strictSql(query => {
    if (query.startsWith("SELECT c.payload")) return [{ payload, source_turn_id: turnId, has_memory_dependencies: true }];
    if (query.startsWith("SELECT t.id FROM opening_turns")) return [{ id: turnId }];
    if (query.startsWith("SELECT status, task_result_ref")) return [{ status: "pending" }];
    if (query.startsWith("INSERT INTO opening_tasks")) return [{ id: taskId, title: payload.title, status: "pending",
      minutes: payload.minutes, due_at: null, priority: 0, version: 1 }];
    if (query.startsWith("SELECT id FROM workspaces") || query.startsWith("SELECT s.id FROM opening_sources")
      || query.startsWith("SELECT c.id FROM opening_assistant_candidates") || query.startsWith("UPDATE opening_assistant_candidates")) {
      return [{ id: candidateId }];
    }
    throw new Error(query);
  });
  await expect(sql.begin(tx => admitTaskCandidate(tx, scope, candidateId))).resolves.toBe(turnId);
  await expect(insertOpeningTaskWithOutcome(sql, scope, {
    candidateId, title: payload.title, minutes: payload.minutes, dueAt: null, priority: 0,
  })).resolves.toMatchObject({ task: { id: taskId }, replayed: false });
});

it("composes turn, note, memory and direct problem predicates without orphaned fragments", async () => {
  const sql = strictSql(() => [{ ok: 1 }]);
  await sql.begin(async tx => {
    await tx`SELECT 1 WHERE ${includedTurn(tx, scope.workspaceId, scope.ownerUserId, "t")}`;
    await tx`SELECT 1 WHERE ${contextSourceRefsIncluded(tx, scope.workspaceId, () => noteContextSourceRefs(tx, () => tx`np.context_source_refs`))}`;
    await tx`SELECT ${turnContextSourceRefs(tx, "t")} WHERE ${memoryTransitiveDependenciesActive(tx)}`;
    await tx`SELECT 1 WHERE ${includedProblem(tx, scope.workspaceId, scope.ownerUserId, "p")}`;
    await tx`SELECT 1 WHERE ${cardReadable(tx, scope.workspaceId)}`;
    await tx`SELECT 1 WHERE ${openingWritingActivityReadableSql(tx, scope, () => tx`a`)}`;
  });
});
