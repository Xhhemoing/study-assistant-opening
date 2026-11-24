import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";
import { createTutorMetadataHandler } from "../../../../apps/worker/src/jobs/tutor-metadata";
import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";
import { loadTutorHistoryContext, readTutorHistoryAncestorStatus } from "./opening-tutor-history";
import { createOpeningConversationRepository } from "./opening-conversations";
import { createOpeningMemoryRepository } from "./opening-memory";
import { admitTaskCandidate, assertTaskCandidateMemoryDependencies } from "./opening-task-candidate-admission";
import { sqlSimulation, unexpected } from "./opening-resident-f11-sql-simulation";
import { assertTutorAttemptContext, readTutorAttemptContext, tutorAttemptFence } from "./opening-tutor-attempt-context";
import {
  assertTutorLearnerMisconceptionSnapshot, readMemoryMisconceptionLineages, readTurnsWithInvalidMisconceptionMemories,
  readTutorLearnerMisconceptionContext, sourceTurnsAllowMisconceptionMemory, turnUsesInactiveMisconception, type TutorMisconceptionSnapshot,
} from "./v3-bitemporal-misconception-memory";

const scope = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const courseId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherCourseId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const jobId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const assistantTurnId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const userTurnId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const at = "2026-11-23 12:00:00.123456+00";
const candidate = { revisionId: "11111111-1111-4111-8111-111111111111", courseId: null as string | null,
  status: "candidate", learnerDisposition: null as string | null, summary: "Check the domain [first]" };
const correction = { ...candidate, revisionId: "22222222-2222-4222-8222-222222222222", status: "learner_reported",
  learnerDisposition: "disputed", summary: "原诊断有异议" };
const cleanLineage = { kind: "v3_misconception_lineage" as const, courseId: null, revisionIds: [] };
const usedLineage = { ...cleanLineage, revisionIds: [candidate.revisionId] };
const lineageRow = { id: userTurnId, current_id: userTurnId, current_course_id: null, assistant_intent_hash: JSON.stringify(usedLineage),
  assistant_source_refs: [], user_source_refs: [], assistant_direct_versioned: true, origin_allowed: true, current_allowed: true };

function setup() {
  const state = {
    privacyEpoch: 7, present: true, pages: [[candidate]], transactionActive: false, contextLocked: false,
    boundCourse: null as string | null, conversationCourse: null as string | null,
    candidateTarget: null as Record<string, unknown> | null, activeLineage: true, afterSnapshot: () => {},
  };
  const rowPagesRead = vi.fn();
  const query = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    if (/^SELECT privacy_epoch FROM workspaces/.test(sql)) {
      expect(sql).toMatch(/owner_user_id\s*=\s*\?/);
      return state.present ? [{ privacy_epoch: state.privacyEpoch }] : [];
    }
    if (sql.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
      expect(state.transactionActive).toBe(true);
      state.contextLocked = true;
      return [];
    }
    if (sql.startsWith("SELECT clock_timestamp()")) {
      expect(state.contextLocked).toBe(true);
      return [{ at }];
    }
    if (sql.startsWith("SELECT e.status")) {
      expect(state.contextLocked).toBe(true);
      return { async *cursor(size: number) {
        expect(size).toBe(64);
        for (const page of state.pages) {
          rowPagesRead();
          yield page;
        }
        state.afterSnapshot();
      } };
    }
    if (sql.startsWith("SELECT j.user_turn_id") || sql.startsWith("SELECT t.attempt_id") || sql.startsWith("SELECT j.*,t.attempt_id")) {
      return [{ id: jobId, workspace_id: scope.workspaceId, assistant_turn_id: assistantTurnId, user_turn_id: userTurnId,
        status: "running", claim_token: null, timing_execution_id: null, created_at: at, updated_at: at,
        course_id: state.conversationCourse, context_anchor: state.boundCourse ? { courseId: state.boundCourse } : null,
        source_ids: [], source_versions: {} }];
    }
    if (sql.startsWith("SELECT id FROM courses")) return [{ id: state.boundCourse ?? state.conversationCourse }];
    if (sql.startsWith("SELECT 1 WHERE")) return [{ ok: true }];
    if (sql.startsWith("SELECT tj.user_turn_id FROM opening_tutor_jobs")) return {};
    if (sql.startsWith("SELECT source_id, source_version, true AS version_required")
      || sql.startsWith("SELECT k.source_id::text AS source_id")
      || sql.startsWith("SELECT COALESCE(array_agg(") || sql.startsWith("SELECT dep.id")
      || sql.startsWith("SELECT CASE WHEN (child.course_id") || sql.startsWith("SELECT lower(dep.id)")
      || sql.startsWith("SELECT (")) return {};
    if (sql.startsWith("WITH candidate_target AS MATERIALIZED")) return state.candidateTarget ? [state.candidateTarget] : [];
    if (sql.startsWith("WITH tick AS MATERIALIZED")) return state.activeLineage ? [{ position: 0 }] : [];
    if (/^(INSERT INTO|SELECT revision FROM) opening_workspace_history_revisions/.test(sql)) return [];
    if (sql.startsWith("UPDATE opening_tutor_jobs") || sql.startsWith("UPDATE opening_turns")) {
      expect(state.transactionActive && state.contextLocked).toBe(true);
      return [{ id: assistantTurnId }];
    }
    if (sql.startsWith("INSERT INTO opening_assistant_candidates") || sql.startsWith("INSERT INTO opening_jobs")
      || sql.startsWith("INSERT INTO opening_outbox")) return [{ id: assistantTurnId }];
    // postgres.js fragments embedded into the job binding SELECT.
    if (!sql.startsWith("SELECT") && !sql.startsWith("UPDATE") && !sql.startsWith("INSERT")) return {};
    throw new Error("Unexpected query: " + sql);
  });
  const transaction = Object.assign(query, { json: (value: unknown) => value, unsafe: (value: string) => value });
  const sql = { async begin(run: (tx: typeof transaction) => Promise<unknown>) {
    expect(state.transactionActive).toBe(false);
    state.transactionActive = true;
    try { return await run(transaction); }
    finally { state.transactionActive = false; state.contextLocked = false; }
  } } as unknown as Sql;
  return { sql, query, state, rowPagesRead };
}

it("checks a restored memory's assistant origin without a tutor job on confirmation and model reuse", async () => {
  const memoryId = "33333333-3333-4333-8333-333333333333";
  const memory = { id: memoryId, workspace_id: scope.workspaceId, course_id: null, text: "Misconception derivative",
    source_turn_ids: [assistantTurnId], version: 0, expires_at: null, status: "active", kind: "candidate", created_at: at, updated_at: at };
  let active = true;
  let confirmationCount = 0;
  const { sql } = sqlSimulation(query => {
    const { text } = query;
    if (text.startsWith("WITH prior AS MATERIALIZED")) return text.includes("OR (u.id=current.id AND a.intent_hash IS NOT NULL)") ? [lineageRow] : [];
    if (text.startsWith("WITH tick AS MATERIALIZED")) return active ? [{ position: 0 }] : [];
    if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (text.startsWith("INSERT INTO opening_workspace_history_revisions") || text.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return [];
    if (text.startsWith("SELECT t.id FROM opening_turns saved")) return [{ id: { turnId: assistantTurnId } }];
    if (text.startsWith("SELECT t.id,") && text.includes(" AS bearing FROM opening_turns")) return [];
    if (text.startsWith("SELECT t.id FROM opening_turns t")) return active ? [{ id: assistantTurnId }] : [];
    if (text.startsWith("SELECT t.id FROM opening_turns")) return [];
    if (text.startsWith("SELECT id FROM opening_memories") && text.includes("lineage.hashes")) {
      return active ? [{ id: { memoryId, hashes: [JSON.stringify(usedLineage)] } }] : [];
    }
    if (text.startsWith("SELECT m.id, course.id AS turn_course_id")) return [{ id: query.values.find(Array.isArray)?.[0], turn_course_id: null,
      historical_user_turn_id: null, refs: [], backings: [], source_ids: [], material_use: null }];
    if (text.startsWith("SELECT m.*,") && text.includes("AS bare_origins")) return confirmationCount ? [{ ...memory, bare_origins: false }] : [];
    if (text.includes("WITH RECURSIVE eligible AS MATERIALIZED") && text.includes("AS evidence_turn_ids")) return [{ ...memory,
      kind: "confirmed", evidence_turn_ids: memory.source_turn_ids, material_source_refs: [] }];
    if (text.startsWith("SELECT m.id, chain.temporary_expires_at")) return [{ id: memoryId, origin_turn_ids: memory.source_turn_ids }];
    if (text.startsWith("SELECT * FROM opening_memories WHERE id")) return [memory];
    if (text.startsWith("UPDATE opening_memories")) { confirmationCount++; return [{ ...memory, kind: "confirmed" }]; }
    return unexpected(query);
  });
  const memories = createOpeningMemoryRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
  await expect(memories.confirm(scope, memoryId, 0, "confirm-active")).resolves.toMatchObject({ kind: "confirmed" });
  const context = await memories.listContext(scope, new Date(at).toISOString());
  expect(context.memories.map(row => row.id)).toEqual([memoryId]);
  expect(context.misconceptionLineage).toEqual(usedLineage);
  active = false;
  await expect(memories.confirm(scope, memoryId, 0, "confirm-after-withdrawal")).rejects.toMatchObject({ code: "VALIDATION" });
  expect(confirmationCount).toBe(1);
  expect((await memories.listContext(scope, new Date(at).toISOString())).memories).toEqual([]);
});

it.each([null, otherCourseId, courseId])("admits a course misconception source only in its own course (%s)", async target => {
  const memoryId = "33333333-3333-4333-8333-333333333333";
  const courseLocked: string[] = [];
  const { sql, queries } = sqlSimulation(query => {
    const { text } = query;
    if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (text.includes("opening_workspace_history_revisions")) return [];
    if (text.startsWith("SELECT id FROM courses")) {
      if (text.endsWith("FOR SHARE")) courseLocked.push(target!);
      return [{ id: target }];
    }
    if (text.startsWith("SELECT t.id FROM opening_turns saved")) return [{ id: assistantTurnId }];
    if (text.startsWith("SELECT t.id FROM opening_turns AS t")) return [];
    if (text.startsWith("SELECT t.id,") && text.includes(" AS bearing FROM opening_turns")) return [];
    if (text.startsWith("SELECT t.id FROM opening_turns t")) {
      expect(text).toContain("prior_a.status = 'complete' AND NOT prior_a.query_system");
      expect(text).toContain("prior_a.created_at, prior_a.id");
      expect(text).toContain("lineage.course_id = ?::uuid");
      expect(query.values).toContain(target);
      if (target !== null) expect(courseLocked).toContain(target);
      return target === courseId ? [{ id: assistantTurnId }] : [];
    }
    if (text.startsWith("SELECT source_turn_ids, text")) return [];
    if (text.startsWith("INSERT INTO opening_memories")) return [{ id: memoryId, workspace_id: scope.workspaceId, course_id: target,
      source_turn_ids: [assistantTurnId], kind: "candidate", status: "active", version: 0, created_at: at, updated_at: at }];
    return unexpected(query);
  });
  const repo = createOpeningMemoryRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
  const propose = repo.proposeMemory(scope, { text: "Derived from a restored exam answer", sourceTurnIds: [assistantTurnId],
    courseId: target, expiresAt: null });
  if (target === courseId) {
    await expect(propose).resolves.toMatchObject({ courseId });
    const insert = queries.findIndex(query => query.text.startsWith("INSERT INTO opening_memories"));
    const checks = queries.flatMap((query, index) => query.text.startsWith("SELECT t.id FROM opening_turns t JOIN") ? [index] : []);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toBeLessThan(insert);
    expect(checks[1]).toBeGreaterThan(insert);
  } else {
    await expect(propose).rejects.toMatchObject({ code: "VALIDATION" });
    expect(queries.some(query => query.text.startsWith("INSERT INTO opening_memories"))).toBe(false);
  }
});

it("rolls back replacement if a restored source's misconception becomes inactive at the privacy fence", async () => {
  const memoryId = "33333333-3333-4333-8333-333333333333";
  const memory = { id: memoryId, workspace_id: scope.workspaceId, course_id: courseId, source_turn_ids: [assistantTurnId],
    kind: "confirmed", status: "active", expires_at: null, text: "Before", version: 1, created_at: at, updated_at: at };
  const checks: number[] = [];
  let epoch = 7;
  let replaced = false;
  const { sql } = sqlSimulation(query => {
    const { text } = query;
    if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (text.includes("opening_workspace_history_revisions") || text.startsWith("UPDATE opening_tutor_jobs")) return [];
    if (text.startsWith("SELECT * FROM opening_memories WHERE id")) return [memory];
    if (text.startsWith("SELECT * FROM opening_memories WHERE workspace_id")) return [];
    if (text.startsWith("SELECT id FROM courses")) return [{ id: courseId }];
    if (text.startsWith("SELECT t.id FROM opening_turns AS t")) return [];
    if (text.startsWith("SELECT t.id FROM opening_turns saved")) return [{ id: assistantTurnId }];
    if (text.startsWith("SELECT t.id,") && text.includes(" AS bearing FROM opening_turns")) return [];
    if (text.startsWith("SELECT t.id FROM opening_turns t JOIN")) {
      checks.push(epoch);
      return epoch === 7 ? [{ id: assistantTurnId }] : [];
    }
    if (text.startsWith("UPDATE opening_memories")) return [{ id: memoryId }];
    if (text.startsWith("INSERT INTO opening_memories")) {
      replaced = true;
      return [{ ...memory, text: "After", version: 2 }];
    }
    if (text.startsWith("UPDATE workspaces SET privacy_epoch")) return [{ id: scope.workspaceId, privacy_epoch: ++epoch }];
    return unexpected(query);
  });
  const repo = createOpeningMemoryRepository(Object.assign(sql, { async begin(run: (tx: typeof sql) => Promise<unknown>) {
    try { return await run(sql); }
    catch (error) { epoch = 7; replaced = false; throw error; }
  } }));
  await expect(repo.replaceMemory(scope, { id: memoryId, expectedVersion: 1, text: "After", sourceTurnIds: [assistantTurnId],
    clientKey: "replace-restored-origin" })).rejects.toMatchObject({ code: "VALIDATION" });
  expect(checks).toEqual([7, 8]);
  expect({ epoch, replaced }).toEqual({ epoch: 7, replaced: false });
});

it("checks a restored task candidate's transitive misconception authority after taking course locks", async () => {
  const candidateId = "33333333-3333-4333-8333-333333333333";
  const dependencyId = "44444444-4444-4444-8444-444444444444";
  let active = true;
  let courseLocked = false;
  const { sql } = sqlSimulation(query => {
    const { text } = query;
    if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (text.startsWith("SELECT c.payload")) return [{ payload: { kind: "task", title: "Practice", minutes: 15, dueText: null },
      source_turn_id: assistantTurnId, has_memory_dependencies: true, assistant_has_memory_dependencies: true, historical_user_turn_id: null,
      source_ids: [], course_id: courseId, role: "assistant", context_source_refs: [{ memoryDependencyIds: [dependencyId] }] }];
    if (text.startsWith("SELECT id FROM courses") && text.endsWith("FOR SHARE")) {
      courseLocked = true;
      return [{ id: courseId }];
    }
    if (text.startsWith("SELECT t.id FROM opening_turns a")) return [{ id: assistantTurnId }];
    if (text.startsWith("SELECT c.id FROM opening_assistant_candidates")) {
      expect(courseLocked).toBe(true);
      expect(text).not.toContain("WITH RECURSIVE");
      return [{ id: candidateId }];
    }
    if (text.startsWith("SELECT t.id, ARRAY(")) {
      expect(courseLocked).toBe(true);
      return [{ id: assistantTurnId, origins: [{ id: assistantTurnId, courseId, consumerCourseId: courseId,
        materialUse: "citation", refs: [{ memoryDependencyIds: [dependencyId] }], standalone: false }] }];
    }
    if (text.startsWith("SELECT id FROM opening_memories")) {
      return active ? [{ id: { memoryId: dependencyId, courseId, active: true, hashes: [], origins: [] } }] : [];
    }
    if (text.startsWith("SELECT dep_m.id")) return [{ id: dependencyId, course_id: courseId, expires_at: null, source_turn_ids: [] }];
    return unexpected(query);
  });
  await expect(admitTaskCandidate(sql, scope, candidateId)).resolves.toBe(assistantTurnId);
  active = false;
  courseLocked = false;
  await expect(admitTaskCandidate(sql, scope, candidateId)).rejects.toMatchObject({ code: "VALIDATION" });
});

it("persists exact restored memory revisions on completion and blocks stream delivery after withdrawal", async () => {
  const root = "33333333-3333-4333-8333-333333333333";
  const originTurn = "44444444-4444-4444-8444-444444444444";
  const jobRow = { id: jobId, workspace_id: scope.workspaceId, user_turn_id: userTurnId, assistant_turn_id: assistantTurnId,
    status: "running", claim_token: null, timing_execution_id: null, created_at: at, updated_at: at,
    source_ids: [], source_versions: {}, course_id: courseId };
  const lineage = { ...usedLineage, courseId };
  let active = true;
  const { sql, queries } = sqlSimulation(query => {
    const { text } = query;
    if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (text.includes("opening_workspace_history_revisions") || text.startsWith("SELECT pg_advisory_xact_lock")) return [];
    if (text.startsWith("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 7 }];
    if (text.startsWith("SELECT t.attempt_id,t.context_anchor") || text.startsWith("SELECT j.*,t.attempt_id")
      || text.startsWith("SELECT j.user_turn_id")) return [jobRow];
    if (text.startsWith("SELECT dep_m.id, dep_m.course_id")) return [{ id: root, course_id: courseId,
      source_turn_ids: [originTurn], expires_at: null }];
    if (text.startsWith("SELECT m.id, course.id AS turn_course_id")) return [{ id: root, turn_course_id: courseId,
      historical_user_turn_id: null, refs: [], backings: [], source_ids: [], material_use: null }];
    if (text.startsWith("SELECT id FROM courses")) return [{ id: courseId }];
    if (text.startsWith("SELECT id FROM opening_memories")) {
      if (!text.includes("lineage.hashes")) return [{ id: root }];
      expect(query.values.slice(0, 3)).toEqual([scope.workspaceId, [root], scope.ownerUserId]);
      return active ? [{ id: { memoryId: root, hashes: [JSON.stringify(lineage)] } }] : [];
    }
    if (text.startsWith("WITH tick AS MATERIALIZED")) return active ? [{ position: 0 }] : [];
    if (text.startsWith("UPDATE opening_tutor_jobs") || text.startsWith("UPDATE opening_turns")) return [{ id: assistantTurnId }];
    return unexpected(query);
  });
  const jobs = createOpeningTutorJobsRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
  const binding = { globalMemoryIds: [root] };
  await jobs.completeTurn({ scope, jobId, assistantTurnId, text: "answer", contextSourceRefs: [], citations: [], candidates: [] }, binding);
  const saved = queries.find(query => query.text.startsWith("UPDATE opening_turns SET text"));
  expect(saved?.values).toContain(JSON.stringify(lineage));
  expect(saved?.values).toContainEqual([{ memoryDependencyIds: [root] }]);

  active = false;
  const deliver = vi.fn(async () => {});
  const stream = { ...binding, privacyEpoch: 7, contextSourceRefs: [], exposureReceiptId: null };
  await expect(jobs.readStream(scope, jobId, stream, deliver)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(jobs.withStreamPublication(scope, jobId, stream, deliver)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(deliver).not.toHaveBeenCalled();
});

it("checks omitted course A memory in its own course while sending selected course B history", async () => {
  const memoryId = "33333333-3333-4333-8333-333333333333";
  const originTurn = "44444444-4444-4444-8444-444444444444";
  const lineage = JSON.stringify({ ...usedLineage, courseId });
  const { sql } = sqlSimulation(query => {
    const { text } = query;
    if (text.startsWith("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 7 }];
    if (text.startsWith("SELECT j.user_turn_id")) return [{ user_turn_id: userTurnId, course_id: otherCourseId,
      context_anchor: null, source_ids: [], source_versions: {} }];
    if (text.startsWith("SELECT dep_m.id, dep_m.course_id")) return [{ id: memoryId, course_id: courseId,
      source_turn_ids: [originTurn], expires_at: null }];
    if (text.startsWith("SELECT m.id, course.id AS turn_course_id")) return [{ id: memoryId, turn_course_id: courseId,
      refs: [], backings: [], source_ids: [], material_use: null }];
    if (text.startsWith("SELECT id FROM courses")) return [{ id: courseId }, { id: otherCourseId }];
    if (text.startsWith("SELECT 1 WHERE NOT EXISTS")) return [{}];
    if (text.startsWith("SELECT id FROM opening_memories") && text.includes("lineage.hashes")) {
      return [{ id: { memoryId, hashes: [lineage], courseId, active: true, origins: [] } }];
    }
    return unexpected(query);
  });
  const jobs = createOpeningTutorJobsRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
  const start = vi.fn(async () => "course B answer");
  await expect(jobs.authorizeSend(scope, jobId, { contextSourceRefs: [], historyCourseBindings: [
    { courseId, materialUse: "citation", sourceIds: [], sourceRefs: [], memoryIds: [memoryId] },
    { courseId: otherCourseId, materialUse: "citation", sourceIds: [], sourceRefs: [] },
  ] }, start)).resolves.toBe("course B answer");
  expect(start).toHaveBeenCalledOnce();
});

it("ignores withdrawn prior misconceptions only when the current answer records its exact lineage", async () => {
  const prior = { ...lineageRow, id: assistantTurnId };
  const current = { ...lineageRow, assistant_intent_hash: JSON.stringify(cleanLineage) };
  const { sql } = sqlSimulation(({ text, values }) => {
    if (text.startsWith("WITH prior AS MATERIALIZED")) return [prior, current];
    if (text.startsWith("WITH tick AS MATERIALIZED")) {
      const bound = values[0] as Array<{ position: number; revision_ids: string[] }>;
      return bound.filter(lineage => !lineage.revision_ids.length);
    }
    return [];
  });
  expect((await readTutorHistoryAncestorStatus(sql, scope, userTurnId)).valid).toBe(true);
  current.assistant_intent_hash = JSON.stringify({ ...cleanLineage, courseId });
  expect((await readTutorHistoryAncestorStatus(sql, scope, userTurnId)).valid).toBe(false);
  current.assistant_intent_hash = JSON.stringify(usedLineage);
  expect((await readTutorHistoryAncestorStatus(sql, scope, userTurnId)).valid).toBe(false);
});

it("delivers a clean explicit stream after prior revocation and rejects legacy or contaminated streams", async () => {
  const prior = { ...lineageRow, id: assistantTurnId };
  const { sql } = sqlSimulation(query => {
    const { text } = query;
    if (text.startsWith("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 7 }];
    if (text.startsWith("SELECT j.*,t.attempt_id")) return [{ id: jobId, workspace_id: scope.workspaceId, user_turn_id: userTurnId,
      assistant_turn_id: assistantTurnId, status: "running", claim_token: null, timing_execution_id: null,
      created_at: at, updated_at: at, source_ids: [], source_versions: {}, has_prior_exchanges: true }];
    if (text.startsWith("WITH prior AS MATERIALIZED")) return [prior];
    if (text.startsWith("WITH tick AS MATERIALIZED") || text.startsWith("SELECT pg_advisory_xact_lock")) return [];
    if (text.startsWith("SELECT 1 WHERE COALESCE(jsonb_typeof(")) return [{ ok: true }];
    return unexpected(query);
  });
  const jobs = createOpeningTutorJobsRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
  const send = vi.fn();
  const context = { privacyEpoch: 7, contextSourceRefs: [], exposureReceiptId: null };
  await expect(jobs.readStream(scope, jobId, { ...context, historyMisconceptionLineage: cleanLineage }, send)).resolves.toMatchObject({ status: "running" });
  expect(send).toHaveBeenCalledOnce();
  await expect(jobs.readStream(scope, jobId, context, send)).rejects.toThrow("stream history is no longer available");
  await expect(jobs.readStream(scope, jobId, { ...context, historyMisconceptionLineage: usedLineage }, send)).rejects.toThrow("history misconception context changed");
  prior.origin_allowed = false;
  await expect(jobs.readStream(scope, jobId, { ...context, historyMisconceptionLineage: cleanLineage }, send)).rejects.toThrow("stream history is no longer available");
  expect(send).toHaveBeenCalledOnce();
});

it("checks withdrawn prior exchanges only for exam streams without explicit lineage", async () => {
  const prior = { ...lineageRow, id: assistantTurnId };
  const { sql } = sqlSimulation(query => {
    const { text } = query;
    if (text.startsWith("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 7 }];
    if (text.startsWith("SELECT j.*,t.attempt_id")) {
      expect(text).toContain("(NOT ? OR t.context_anchor->>'purpose' IS DISTINCT FROM 'exam_help') AND EXISTS (");
      return [{ id: jobId, workspace_id: scope.workspaceId, user_turn_id: userTurnId, assistant_turn_id: assistantTurnId,
        status: "running", claim_token: null, timing_execution_id: null, created_at: at, updated_at: at,
        context_anchor: { purpose: "exam_help" }, source_ids: [], source_versions: {}, has_prior_exchanges: query.values[0] !== true }];
    }
    if (text.startsWith("WITH prior AS MATERIALIZED")) return [prior];
    if (text.startsWith("WITH tick AS MATERIALIZED") || text.startsWith("SELECT pg_advisory_xact_lock")) return [];
    if (text.startsWith("SELECT 1 WHERE COALESCE(jsonb_typeof(")) return [{ ok: true }];
    return unexpected(query);
  });
  const jobs = createOpeningTutorJobsRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
  const deliver = vi.fn();
  const context = { privacyEpoch: 7, contextSourceRefs: [], exposureReceiptId: null };

  await expect(jobs.readStream(scope, jobId, context, deliver)).rejects.toThrow("stream history is no longer available");
  expect(deliver).not.toHaveBeenCalled();
  await expect(jobs.readStream(scope, jobId, { ...context, historyMisconceptionLineage: cleanLineage }, deliver))
    .resolves.toMatchObject({ status: "running" });
  expect(deliver).toHaveBeenCalledOnce();
});

it("admits submitted photo-only exam guidance and revalidates provenance without requiring a transcription", async () => {
  const attemptId = "33333333-3333-4333-8333-333333333333";
  const itemVersionId = "44444444-4444-4444-8444-444444444444";
  const photo = { id: "55555555-5555-4555-8555-555555555555", version: 1, physicalPage: 1 };
  const attempt = { course_id: null, session_id: jobId, activity_id: courseId, item_version_id: itemVersionId, problem_id: jobId, create_intent: {} };
  const observation = { id: assistantTurnId, answer: "", answer_revision: 1, attempt_id: attemptId,
    item_version_id: itemVersionId, session_id: jobId, course_id: null, workspace_history_revision: 12,
    revision_kind: "submit", grading_work_source: photo };
  let purpose = "exam_help";
  let available = true;
  const { sql } = sqlSimulation(query => {
    const { text } = query;
    if (text.startsWith("SELECT t.attempt_id,t.context_anchor")) return [{ attempt_id: attemptId, context_anchor: { purpose, attemptId },
      learning_session_id: jobId, course_id: null, privacy_epoch: 7 }];
    if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (text.startsWith("SELECT * FROM opening_learning_attempts")) return [attempt];
    if (text.startsWith("SELECT * FROM opening_learning_sessions")) return [{ activity_id: courseId, course_id: null }];
    if (text.startsWith("SELECT * FROM opening_teaching_activities")) return [{ id: courseId, course_id: null, client_key: "activity-1" }];
    if (text.startsWith("SELECT * FROM opening_learning_item_versions")) return [{ id: itemVersionId, course_id: null, problem_id: jobId }];
    if (text.startsWith("SELECT v.stem_snapshot")) return [{ ...attempt, stem_snapshot: "Question", observation_id: observation.id, submitted_at: at }];
    if (text.startsWith("SELECT to_jsonb(root) AS original")) return [{ original: observation, current: observation, previous: null }];
    if (text.startsWith("SELECT ref FROM jsonb_array_elements")) return [];
    if (text.endsWith("AS included")) return [{ included: available }];
    return unexpected(query);
  });
  const target = { userTurnId, jobId };
  const context = await readTutorAttemptContext(sql, scope, target);
  expect(context).toMatchObject({ currentAnswer: { answer: "", answerRevision: 1 }, workSource: photo,
    sourceRefs: [{ sourceId: photo.id, sourceVersion: photo.version }] });
  expect(tutorAttemptFence(context!)).toMatchObject({ headObservationId: observation.id, answerRevision: 1, headRevision: 12 });
  await expect(assertTutorAttemptContext(sql, scope, target, context!)).resolves.toBeUndefined();
  available = false;
  await expect(assertTutorAttemptContext(sql, scope, target, context!)).rejects.toMatchObject({ code: "CONFLICT" });
  available = true;
  for (purpose of ["learning_help", "history_solution"]) {
    await expect(readTutorAttemptContext(sql, scope, target)).rejects.toMatchObject({ reasonCode: "ATTEMPT_ANSWER_TEXT_UNAVAILABLE" });
  }
});

it.each([
  { query_system: true, composer_purpose: "answer" },
  { query_system: false, composer_purpose: "plan" },
  { query_system: false, composer_purpose: "query" },
  { query_system: false, composer_purpose: "explain_state" },
])("freezes a read-only exam snapshot for %j without applying study intent", async flags => {
  const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const row = { ...flags, assistant_turn_id: assistantTurnId, mode: "hint",
    context_anchor: { purpose: "exam_help" }, help_input_snapshot: null as unknown,
    text: "我是猜的", attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    learning_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2" };
  const query = vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => {
    const statement = parts.join("?").replace(/\s+/g, " ").trim();
    if (statement.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (/^(INSERT INTO|SELECT revision FROM) opening_workspace_history_revisions/.test(statement)) return [];
    if (statement.startsWith("SELECT t.*,j.assistant_turn_id")) {
      expect(values).toEqual([jobId, userTurnId, scope.workspaceId, scope.ownerUserId, claimToken]);
      return [row];
    }
    if (statement.startsWith("UPDATE opening_turns SET help_input_snapshot")) {
      row.help_input_snapshot = values[0];
      return [];
    }
    throw new Error("Unexpected query: " + statement);
  });
  const tx = Object.assign(query, { json: (value: unknown) => value });
  const jobs = createOpeningTutorJobsRepository({ begin: (run: (tx: typeof query) => unknown) => run(tx) } as unknown as Sql);
  const input = { userTurnId, jobId, claimToken };
  const expected = { userTurnId, assistantTurnId, tutorMode: "hint", studyIntent: null };

  await expect(jobs.freezeHelpInputSnapshot(scope, input)).resolves.toEqual(expected);
  await expect(jobs.freezeHelpInputSnapshot(scope, input)).resolves.toEqual(expected);
  expect(query.mock.calls.filter(([parts]) => parts[0]!.trim().startsWith("UPDATE opening_turns"))).toHaveLength(1);
  await expect(jobs.applyUserTurnIntent(scope, input)).rejects.toThrow("read-only or proposal composer purpose cannot change study intent");
  row.context_anchor.purpose = "learning_help";
  await expect(jobs.freezeHelpInputSnapshot(scope, input)).rejects.toThrow("read-only or proposal composer purpose cannot change study intent");
  expect(query.mock.calls.some(([parts]) => parts.join("").includes("opening_study_intent_events"))).toBe(false);
});

it.each([courseId, null])("reads owner-scoped active rows using the course filter %s and a locked database clock", async selectedCourse => {
  const { sql, query, state } = setup();
  state.pages = [[{ ...correction, courseId: selectedCourse?.toUpperCase() ?? null }, candidate]];
  const snapshot = await readTutorLearnerMisconceptionContext(sql, scope, { courseId: selectedCourse, expectedPrivacyEpoch: 7 });
  expect(snapshot).toMatchObject({
    courseId: selectedCourse, effectiveCourseId: selectedCourse, privacyEpoch: 7, revisionIds: [correction.revisionId, candidate.revisionId],
    renderedMarkdown: "- 学习者提出异议：原诊断有异议\n- 待确认：Check the domain \\[first\\]",
  });
  const [template, ...params] = query.mock.lastCall!;
  const statement = template.join("?");
  expect(statement).toContain("e.workspace_id = ? AND e.owner_user_id = ?");
  expect(statement).toContain("e.privacy_epoch = w.privacy_epoch");
  expect(statement).toContain("AND (? OR e.course_id IS NULL OR e.course_id = ?::uuid)");
  expect(statement).toContain("e.valid_range @> ?::text::timestamptz AND e.tx_range @> ?::text::timestamptz");
  expect(statement).toContain("e.status IN ('candidate', 'verified', 'learner_reported')");
  expect(statement).toContain("ORDER BY (e.status = 'learner_reported') DESC, lower(e.tx_range) DESC, e.edge_id, e.revision_id");
  expect(params.slice(0, 6)).toEqual([scope.workspaceId, scope.ownerUserId, false, selectedCourse, at, at]);
});

it("captures the exact included revisions through Unicode blanks and UTF-8 truncation", async () => {
  const { sql, state, rowPagesRead } = setup();
  state.pages = [[{ ...candidate, revisionId: "blank", summary: "\u2003" }, correction],
    [{ ...candidate, revisionId: "truncated", summary: "🙂".repeat(800), status: "verified" }, { ...candidate, courseId }],
    [{ ...candidate, revisionId: "never-read" }]];
  const snapshot = await readTutorLearnerMisconceptionContext(sql, scope, { courseId });
  expect(snapshot!.revisionIds).toEqual([correction.revisionId, "truncated"]);
  expect(snapshot!.effectiveCourseId).toBeNull();
  expect(snapshot!.byteLength).toBe(Buffer.byteLength(snapshot!.renderedMarkdown));
  expect(snapshot!.byteLength).toBeGreaterThan(2044);
  expect(snapshot!.byteLength).toBeLessThanOrEqual(2048);
  expect(snapshot!.renderedMarkdown).toContain("\n- 已确认：🙂");
  expect(rowPagesRead).toHaveBeenCalledTimes(2);
});

it("returns no snapshot for an absent workspace and an empty snapshot when nothing rendered", async () => {
  const { sql, query, state } = setup();
  state.present = false;
  await expect(readTutorLearnerMisconceptionContext(sql, scope, { courseId: null })).resolves.toBeNull();
  expect(query).toHaveBeenCalledOnce();
  state.present = true;
  state.pages = [[{ ...candidate, summary: "\u2003" }]];
  await expect(readTutorLearnerMisconceptionContext(sql, scope, { courseId })).resolves.toEqual({
    courseId, effectiveCourseId: null, privacyEpoch: 7, revisionIds: [], renderedMarkdown: "", byteLength: 0,
  });
});

it.each(["first insert", "correction", "retraction", "epoch", "revision identity", "rendering", "course"])(
  "refuses a stale or mismatched snapshot on %s before send, publication, stream delivery or completion", async change => {
    const { sql, query, state } = setup();
    const jobs = createOpeningTutorJobsRepository(sql);
    if (change === "first insert") state.pages = [];
    const snapshot = (await readTutorLearnerMisconceptionContext(sql, scope, { courseId: null }))!;
    await expect(assertTutorLearnerMisconceptionSnapshot(sql, scope, snapshot)).resolves.toBeUndefined();
    let supplied: TutorMisconceptionSnapshot = snapshot;
    if (change === "first insert") state.pages = [[candidate]];
    if (change === "correction") state.pages = [[correction]];
    if (change === "retraction") state.pages = [];
    if (change === "epoch") state.privacyEpoch++;
    if (change === "revision identity") state.pages = [[{ ...candidate, revisionId: "new revision" }]];
    if (change === "rendering") state.pages = [[{ ...candidate, summary: "changed" }]];
    if (change === "course") supplied = { ...snapshot, courseId };
    const code = change === "epoch" ? "PRIVACY_EPOCH_MISMATCH" : "CONFLICT";
    if (change !== "course") await expect(assertTutorLearnerMisconceptionSnapshot(sql, scope, supplied)).rejects.toMatchObject({ code });
    const action = vi.fn(async () => {});
    const context = { contextSourceRefs: [], misconceptionSnapshot: supplied };
    await expect(jobs.authorizeSend(scope, jobId, context, action)).rejects.toMatchObject({ code });
    await expect(jobs.withStreamPublication(scope, jobId, { ...context, privacyEpoch: state.privacyEpoch }, action)).rejects.toMatchObject({ code });
    const cache = { ...context, privacyEpoch: state.privacyEpoch, exposureReceiptId: null };
    await expect(jobs.readStream(scope, jobId, cache)).rejects.toMatchObject({ code });
    await expect(jobs.readStream(scope, jobId, cache, action)).rejects.toMatchObject({ code });
    await expect(jobs.completeTurn({ scope, jobId, assistantTurnId, text: "draft", citations: [], candidates: [] },
      { misconceptionSnapshot: supplied })).rejects.toMatchObject({ code });
    expect(action).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([parts]) => parts[0]!.trim().startsWith("UPDATE opening_tutor_jobs"))).toBe(false);
  },
);

it("holds the advisory lock while starting a send, publishing, delivering and completing a current snapshot", async () => {
  const { sql, state } = setup();
  const jobs = createOpeningTutorJobsRepository(sql);
  const misconceptionSnapshot = (await readTutorLearnerMisconceptionContext(sql, scope, { courseId: null }))!;
  const action = vi.fn(async () => {
    expect(state.contextLocked).toBe(true);
    expect(state.transactionActive).toBe(true);
  });
  const context = { contextSourceRefs: [], misconceptionSnapshot };
  await jobs.authorizeSend(scope, jobId, context, action);
  await jobs.withStreamPublication(scope, jobId, { ...context, privacyEpoch: state.privacyEpoch }, action);
  await jobs.readStream(scope, jobId, { ...context, privacyEpoch: state.privacyEpoch, exposureReceiptId: null }, action);
  await jobs.completeTurn({ scope, jobId, assistantTurnId, text: "answer", citations: [], candidates: [],
    expectedPrivacyEpoch: state.privacyEpoch }, { misconceptionSnapshot });
  expect(action).toHaveBeenCalledTimes(3);
});

it.each(["course-bound conversation", "course-anchored conversation", "global revision"])(
  "persists backup-compatible assistant lineage and gates metadata for a %s", async kind => {
    const { sql, query, state } = setup();
    const jobs = createOpeningTutorJobsRepository(sql);
    const global = kind === "global revision";
    state.conversationCourse = kind === "course-bound conversation" ? courseId : null;
    state.boundCourse = courseId;
    state.pages = [[{ ...candidate, courseId: global ? null : courseId }]];
    const snapshot = (await readTutorLearnerMisconceptionContext(sql, scope, { courseId }))!;
    const { effectiveCourseId: _implicitCourse, ...legacySnapshot } = snapshot;
    await jobs.completeTurn({ scope, jobId, assistantTurnId, text: "answer", citations: [],
      contextSourceRefs: [], candidates: [{ sourceIds: [], payload: { kind: "task" } }], enqueueMetadata: true },
    { misconceptionSnapshot: kind === "course-anchored conversation" ? legacySnapshot : snapshot });
    const [template, ...values] = query.mock.calls.find(([parts]) => parts[0]!.trim().startsWith("UPDATE opening_turns"))!;
    const lineage = JSON.stringify({ kind: "v3_misconception_lineage", courseId: global ? null : courseId, revisionIds: [candidate.revisionId] });
    expect(template.join("?")).toContain("role = 'assistant'");
    expect(template.join("?")).not.toContain("context_anchor");
    expect(values).toContain(lineage);
    expect(values).toContainEqual([]);
    const allowsMetadata = kind !== "course-anchored conversation";
    for (const table of ["opening_assistant_candidates", "opening_jobs", "opening_outbox"]) {
      expect(query.mock.calls.some(([parts]) => parts[0]!.trim().startsWith(`INSERT INTO ${table}`))).toBe(allowsMetadata);
    }
    state.candidateTarget = { assistant_intent_hash: lineage, conversation_course_id: state.conversationCourse,
      course_id: courseId, answer: "answer", question: "question", user_turn_id: userTurnId, mode: "hint" };
    const target = { scope, jobId, assistantTurnId };
    expect(await jobs.canAppendCompletedTurnCandidates(target)).toBe(allowsMetadata);
    state.activeLineage = false;
    const send = vi.fn(async () => {});
    await expect(jobs.authorizeMetadataSend(target, send)).rejects.toThrow("tutor metadata authorization changed");
    expect(send).not.toHaveBeenCalled();
  },
);

it("cuts off inactive or malformed misconception ancestry and selects course-bound answers only in their course", async () => {
  const lineage = (id: string | null) => JSON.stringify({ kind: "v3_misconception_lineage", courseId: id, revisionIds: [candidate.revisionId] });
  const prior = { current_id: userTurnId, current_course_id: courseId, assistant_intent_hash: lineage(courseId),
    question: "prior question", answer: "course A misconception answer", user_source_refs: [], assistant_source_refs: [],
    user_direct_ids: [], assistant_direct_ids: [], assistant_direct_versioned: true, origin_allowed: true, current_allowed: true };
  const recent = { ...prior, assistant_intent_hash: null, assistant_inherited_misconception_hashes: [lineage(courseId)],
    question: "more recent follow-up", answer: "derived follow-up" };
  let priorRows: Array<typeof prior | typeof recent> = [recent, prior];
  let authorityActive = true;
  const checkAuthority = vi.fn((positions: { position: number }[]) => authorityActive ? positions : []);
  const sql = Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => {
    const statement = parts.join("?");
    if (statement.includes("WITH prior AS MATERIALIZED")) return priorRows;
    if (!statement.includes("AS lineage(position integer")) return [];
    expect(statement).toContain("c.workspace_id = w.id AND c.archived_at IS NULL");
    expect(statement).toContain("e.privacy_epoch = w.privacy_epoch");
    expect(statement).toContain("e.workspace_id = w.id AND e.owner_user_id = w.owner_user_id");
    expect(statement).toContain("e.valid_range @> tick.at AND e.tx_range @> tick.at");
    expect(statement).toContain("e.status IN ('candidate', 'verified', 'learner_reported')");
    expect(values.slice(1)).toEqual([scope.workspaceId, scope.ownerUserId]);
    return checkAuthority(values[0] as { position: number }[]);
  }, { json: (value: unknown) => value, unsafe: (value: string) => value }) as unknown as Sql;
  const load = () => loadTutorHistoryContext(sql, scope, userTurnId);
  expect(await load()).toMatchObject({ history: expect.arrayContaining([{ role: "assistant", text: prior.answer }, { role: "assistant", text: recent.answer }]),
    historyMisconceptionLineage: JSON.parse(lineage(courseId)),
    historyCourseBindings: expect.arrayContaining([expect.objectContaining({ courseId })]) });
  const collectCourseIds = new Set<string>();
  expect(await readTutorHistoryAncestorStatus(sql, scope, userTurnId, { collectCourseIds })).toMatchObject({ valid: true });
  expect(collectCourseIds).toEqual(new Set([courseId]));
  for (const currentCourse of [null, otherCourseId]) {
    priorRows = [{ ...recent, current_course_id: currentCourse }, { ...prior, current_course_id: currentCourse }] as typeof priorRows;
    expect(await load()).toEqual({ history: [], sourceRefs: [] });
    priorRows = [{ ...prior, current_course_id: currentCourse, assistant_intent_hash: lineage(null) } as typeof prior];
    expect(await load()).toMatchObject({ history: expect.arrayContaining([{ role: "assistant", text: prior.answer }]) });
  }
  for (const assistant_intent_hash of [lineage(courseId), "invalid", JSON.stringify({ courseId, revisionIds: ["invalid"] })]) {
    authorityActive = false;
    priorRows = [recent, { ...prior, assistant_intent_hash }];
    expect(await load()).toEqual({ history: [], sourceRefs: [] });
    expect(await readTutorHistoryAncestorStatus(sql, scope, userTurnId)).toMatchObject({ valid: false });
  }
  priorRows = [{ ...recent, assistant_inherited_misconception_hashes: [] }];
  checkAuthority.mockClear();
  expect(await load()).toMatchObject({ history: expect.arrayContaining([{ role: "assistant", text: recent.answer }]) });
  expect(checkAuthority).not.toHaveBeenCalled();
});

it("revalidates inherited revisions and persists their course even with an empty direct snapshot", async () => {
  const { sql, query, state } = setup();
  const jobs = createOpeningTutorJobsRepository(sql);
  state.boundCourse = courseId;
  state.pages = [];
  const misconceptionSnapshot = (await readTutorLearnerMisconceptionContext(sql, scope, { courseId }))!;
  const historyMisconceptionLineage = { kind: "v3_misconception_lineage" as const, courseId, revisionIds: [candidate.revisionId] };
  const context = { contextSourceRefs: [], misconceptionSnapshot, historyMisconceptionLineage,
    privacyEpoch: state.privacyEpoch, exposureReceiptId: null };
  const action = vi.fn(async () => {});
  state.activeLineage = false;
  await expect(jobs.authorizeSend(scope, jobId, context, action)).rejects.toThrow("history misconception context changed");
  await expect(jobs.readStream(scope, jobId, context, action)).rejects.toThrow("history misconception context changed");
  expect(action).not.toHaveBeenCalled();
  state.activeLineage = true;
  await jobs.completeTurn({ scope, jobId, assistantTurnId, text: "follow-up", citations: [], candidates: [], enqueueMetadata: true }, context);
  const update = query.mock.calls.find(([parts]) => parts[0]!.trim().startsWith("UPDATE opening_turns"));
  expect(update).toContain(JSON.stringify(historyMisconceptionLineage));
  expect(query.mock.calls.some(([parts]) => parts[0]!.trim().startsWith("INSERT INTO opening_jobs"))).toBe(false);
});

it("rechecks temporary expiry after waiting for the misconception snapshot at every delivery boundary", async () => {
  const { sql, query, state } = setup();
  const jobs = createOpeningTutorJobsRepository(sql);
  const misconceptionSnapshot = (await readTutorLearnerMisconceptionContext(sql, scope, { courseId: null }))!;
  const now = Date.now();
  const temporaryMemoryExpiresAt = new Date(now + 60_000).toISOString();
  const clock = vi.spyOn(Date, "now");
  const context = { contextSourceRefs: [], misconceptionSnapshot, temporaryMemoryExpiresAt, privacyEpoch: state.privacyEpoch };
  const action = vi.fn(async () => {});
  try {
    state.afterSnapshot = () => clock.mockReturnValue(now + 60_000);
    for (const run of [
      () => jobs.authorizeSend(scope, jobId, context, action),
      () => jobs.withStreamPublication(scope, jobId, context, action),
      () => jobs.readStream(scope, jobId, { ...context, exposureReceiptId: null }, action),
      () => jobs.completeTurn({ scope, jobId, assistantTurnId, text: "answer", citations: [], candidates: [] }, context),
    ]) {
      clock.mockReturnValue(now);
      await expect(run()).rejects.toThrow("stream temporary memory is no longer active");
    }
    expect(action).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([parts]) => parts[0]!.trim().startsWith("UPDATE opening_tutor_jobs"))).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

it.skipIf(process.env.OPENING_PGLITE_PG16 !== "1")("executes saved misconception lineage validation on PostgreSQL 16", async () => {
  // PGlite is provisioned locally for this optional real-SQL test so the workspace lockfile stays unchanged.
  const packageName = "@electric-sql/pglite";
  const { PGlite } = await import(packageName) as {
    PGlite: new () => {
      exec(query: string): Promise<unknown>;
      query<T>(query: string, params?: unknown[]): Promise<{ rows: T[] }>;
      close(): Promise<void>;
    };
  };
  const db = new PGlite();
  try {
    expect((await db.query<{ server_version_num: string }>("SHOW server_version_num")).rows[0]?.server_version_num)
      .toMatch(/^16\d{4}$/);
    await db.exec(`
      SET enable_seqscan = on;
      CREATE TABLE workspaces (id uuid PRIMARY KEY, owner_user_id uuid, privacy_epoch int);
      CREATE TABLE courses (id uuid PRIMARY KEY, workspace_id uuid, archived_at timestamptz);
      CREATE TABLE opening_conversations (id uuid PRIMARY KEY, workspace_id uuid, owner_user_id uuid, course_id uuid,
        title text DEFAULT 'Tutor', updated_at timestamptz DEFAULT now());
      CREATE TABLE opening_turns (id uuid PRIMARY KEY, workspace_id uuid, conversation_id uuid, role text, status text,
        attempt_id uuid, source_ids uuid[] DEFAULT '{}', source_versions jsonb DEFAULT '{}', citations jsonb DEFAULT '[]',
        chunk_id uuid, text text DEFAULT 'Answer', mode text DEFAULT 'listen',
        intent_hash text, context_source_refs jsonb, context_anchor jsonb, query_system bool, system_query jsonb,
        created_at timestamptz, learning_session_id uuid);
      CREATE TABLE opening_tutor_jobs (id uuid PRIMARY KEY, workspace_id uuid, conversation_id uuid, user_turn_id uuid,
        assistant_turn_id uuid UNIQUE, status text DEFAULT 'succeeded', error jsonb, claim_token uuid, timing_execution_id uuid,
        mode text DEFAULT 'listen');
      CREATE TABLE opening_learning_sessions (id uuid PRIMARY KEY, workspace_id uuid, owner_user_id uuid, course_id uuid,
        activity_id uuid, source_ids uuid[]);
      CREATE TABLE opening_teaching_activities (id uuid PRIMARY KEY, workspace_id uuid, owner_user_id uuid, source_ids uuid[]);
      CREATE TABLE opening_source_chunks (id uuid PRIMARY KEY, source_id uuid, source_version int);
      CREATE TABLE opening_sources (id uuid PRIMARY KEY, workspace_id uuid, version int, upload_state text);
      CREATE TABLE opening_source_versions (workspace_id uuid, source_id uuid, version int, availability text);
      CREATE TABLE opening_privacy_exclusions (workspace_id uuid, source_id uuid, asset_deleted_at timestamptz);
      CREATE TABLE course_asset_memberships (id uuid PRIMARY KEY, workspace_id uuid, course_id uuid, asset_id uuid, asset_type text, purpose text);
      CREATE TABLE opening_help_exposures (id uuid PRIMARY KEY, workspace_id uuid, owner_user_id uuid, turn_id uuid,
        exposure_origin text, release_key text, released_at timestamptz);
      CREATE TABLE opening_jobs (id uuid PRIMARY KEY, workspace_id uuid, owner_user_id uuid, kind text, state text,
        claim_token uuid, privacy_epoch int, payload jsonb);
      CREATE TABLE opening_assistant_candidates (id uuid PRIMARY KEY, workspace_id uuid, conversation_id uuid,
        source_turn_id uuid, source_ids jsonb, payload jsonb);
      CREATE TABLE opening_workspace_history_revisions (workspace_id uuid PRIMARY KEY, owner_user_id uuid, revision bigint DEFAULT 0);
      CREATE TABLE opening_memories (id uuid PRIMARY KEY, workspace_id uuid, course_id uuid, source_turn_ids jsonb,
        text text DEFAULT 'Memory', version int DEFAULT 1, status text DEFAULT 'active', kind text DEFAULT 'confirmed',
        expires_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE v3_bitemporal_misconception_edges (revision_id uuid PRIMARY KEY, workspace_id uuid, owner_user_id uuid,
        course_id uuid, privacy_epoch int, valid_range tstzrange, tx_range tstzrange, status text);
    `);
    await db.query("INSERT INTO workspaces VALUES ($1,$2,7)", [scope.workspaceId, scope.ownerUserId]);
    await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,NULL)", [jobId, scope.workspaceId, scope.ownerUserId]);
    await db.query("INSERT INTO v3_bitemporal_misconception_edges VALUES ($1,$2,$3,NULL,7,'(,)','(,)','candidate')",
      [candidate.revisionId, scope.workspaceId, scope.ownerUserId]);
    const plans: { query: string; cost: number }[] = [];
    let explain = false;
    class SqlFragment {
      constructor(readonly parts: readonly string[], readonly values: unknown[] = []) {}
      render(params: unknown[]): string {
        return this.parts.map((part, index) => {
          if (index === this.values.length) return part;
          const value = this.values[index];
          return part + (value instanceof SqlFragment ? value.render(params) : "$" + params.push(value));
        }).join("");
      }
      then(resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) {
        return this.execute().then(resolve, reject);
      }
      async execute() {
        const params: unknown[] = [];
        const query = this.render(params).trim();
        if (explain && /^(SELECT|WITH)\b/.test(query)) {
          const result = await db.query<{ "QUERY PLAN": { Plan: { "Total Cost": number } }[] }>(
            "EXPLAIN (FORMAT JSON) " + query, params);
          const cost = result.rows[0]!["QUERY PLAN"][0]!.Plan["Total Cost"];
          plans.push({ query, cost });
          expect(cost, query.slice(0, 110)).toBeLessThan(20_000);
        }
        return (await db.query(query, params)).rows;
      }
    }
    const sql = Object.assign(
      (parts: TemplateStringsArray, ...values: unknown[]) => new SqlFragment(parts, values),
      { unsafe: (text: string) => new SqlFragment([text]), json: JSON.stringify,
        begin: (run: (tx: Sql) => Promise<unknown>) => run(sql) },
    ) as unknown as Sql;
    const read = async () => {
      const [row] = await sql`SELECT ${turnUsesInactiveMisconception(sql)} AS hidden FROM opening_turns t WHERE t.id=${assistantTurnId}`;
      const invalid = await readTurnsWithInvalidMisconceptionMemories(sql, scope, [assistantTurnId], { display: true });
      return [{ hidden: row?.hidden || invalid.has(assistantTurnId) }];
    };
    for (const [encoded, hidden] of [
      [JSON.stringify(usedLineage), false], ["{", true], ["[]", true], ['"scalar"', true], ["null", true],
      [JSON.stringify({ ...usedLineage, revisionIds: [candidate.revisionId, candidate.revisionId] }), true],
      ['{"kind":"dup","kind":"v3_misconception_lineage","courseId":null,"revisionIds":[]}', true],
      ['{"kind":"v3_misconception_lineage","kind":"dup","courseId":null,"revisionIds":[]}', true],
    ] as const) {
      await db.exec("TRUNCATE opening_turns");
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,
        context_source_refs,query_system,created_at) VALUES ($1,$2,$3,'assistant','complete',$4,'[]',false,now())`,
        [assistantTurnId, scope.workspaceId, jobId, encoded]);
      await expect(read()).resolves.toEqual([{ hidden }]);
    }

    // A restored answer has no job, exact hash, or direct memory refs. Its earlier answer
    // recorded only the memory ID, and that memory was itself derived from an exact lineage.
    const originId = "33333333-3333-4333-8333-333333333333";
    const originConversation = "44444444-4444-4444-8444-444444444444";
    const memoryId = "55555555-5555-4555-8555-555555555555";
    const derivedMemory = "66666666-6666-4666-8666-666666666666";
    const exact = { ...usedLineage, courseId };
    await db.exec("TRUNCATE opening_turns");
    await db.query("INSERT INTO courses VALUES ($1,$2,NULL)", [courseId, scope.workspaceId]);
    await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=$1", [courseId]);
    await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,$4)", [originConversation, scope.workspaceId, scope.ownerUserId, courseId]);
    await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
      context_anchor,query_system,created_at)
      VALUES ($1,$4,$5,'assistant','complete',$6,'[]',NULL,false,now()-interval '3 minutes'),
             ($2,$4,$7,'assistant','complete',NULL,$8,$9,false,now()-interval '2 minutes'),
             ($3,$4,$7,'assistant','complete',NULL,'[]',$9,false,now()-interval '1 minute')`,
      [originId, userTurnId, assistantTurnId, scope.workspaceId, originConversation, JSON.stringify(exact), jobId,
        JSON.stringify([{ memoryDependencyIds: [memoryId] }]), JSON.stringify({ courseId })]);
    await db.query("INSERT INTO opening_memories(id,workspace_id,course_id,source_turn_ids) VALUES ($1,$3,$4,$5), ($2,$3,$4,$6)",
      [memoryId, derivedMemory, scope.workspaceId, courseId, JSON.stringify([originId]), JSON.stringify([assistantTurnId])]);
    await db.exec('ANALYZE');
    explain = true;
    await expect(read()).resolves.toEqual([{ hidden: false }]);
    await expect(readMemoryMisconceptionLineages(sql, scope, [derivedMemory], courseId))
      .resolves.toEqual(new Map([[derivedMemory, exact]]));
    await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [assistantTurnId], null)).resolves.toBe(false);
    await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [assistantTurnId], courseId)).resolves.toBe(true);

    const repo = createOpeningConversationRepository(sql);
    const jobs = createOpeningTutorJobsRepository(sql);
    const candidateId = "77777777-7777-4777-8777-777777777777";
    const historyUser = "88888888-8888-4888-8888-888888888888";
    const currentUser = "99999999-9999-4999-8999-999999999999";
    const restoredAnswer = "Saved follow-up";
    const unavailable = "关联学习记录已更新或撤回，此回答内容不再显示。";
    const expiry = new Date(Date.now() + 120_000).toISOString();
    await db.query("INSERT INTO courses VALUES ($1,$2,NULL)", [otherCourseId, scope.workspaceId]);
    await db.query("UPDATE opening_turns SET text=$1,intent_hash=$2,context_source_refs='[]' WHERE id=$3",
      [restoredAnswer, JSON.stringify(exact), userTurnId]);
    await db.query("UPDATE opening_turns SET text=$1 WHERE id=$2", [restoredAnswer, assistantTurnId]);
    await db.query("INSERT INTO opening_assistant_candidates VALUES ($1,$2,$3,$4,'[]',$5)",
      [candidateId,scope.workspaceId,jobId,assistantTurnId,{kind:"task",title:"Practice",minutes:15,dueText:null}]);
    for (const destination of [otherCourseId, null]) {
      await db.query("UPDATE opening_turns SET context_anchor=$1 WHERE id=$2",
        [destination === null ? null : { courseId: destination }, assistantTurnId]);
      await expect(repo.listTurns(scope, jobId)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: assistantTurnId, text: unavailable }),
      ]));
      await expect(repo.listSummaries(scope)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: jobId, lastTurnPreview: unavailable }),
      ]));
      await expect(repo.releaseReturnedTurnIds(scope, jobId, [assistantTurnId])).resolves.toEqual([
        { id: assistantTurnId, role: "assistant", text: unavailable, citations: [] },
      ]);
      await expect(admitTaskCandidate(sql as never, scope, candidateId)).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [assistantTurnId], destination)).resolves.toBe(false);
    }
    await db.query("UPDATE opening_turns SET intent_hash=NULL,context_source_refs=$1 WHERE id=$2",
      [JSON.stringify([{ memoryDependencyIds: [memoryId] }]), userTurnId]);
    await db.query("UPDATE opening_turns SET context_anchor=$1 WHERE id=$2", [{ courseId }, assistantTurnId]);
    await db.query("UPDATE opening_memories SET kind='temporary',expires_at=$1 WHERE id=$2", [expiry,memoryId]);
    await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,context_source_refs,
        context_anchor,query_system,created_at,text)
      VALUES ($1,$3,$4,'user','complete','[]',$5,false,now()-interval '90 seconds','Saved question'),
        ($2,$3,$4,'user','complete','[]',$5,false,now(),'New question')`,
      [historyUser,currentUser,scope.workspaceId,jobId,{ courseId }]);
    await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$1,$3,$4)",
      [jobId,scope.workspaceId,historyUser,assistantTurnId]);
    await db.exec('ANALYZE');
    const history = await loadTutorHistoryContext(sql, scope, currentUser);
    expect(history.history.map(turn => turn.text)).toEqual(["Saved question", restoredAnswer]);
    expect(history.memoryIds).toContain(memoryId);
    expect(history.temporaryMemoryExpiresAt).toBe(expiry);
    expect(history.historyCourseBindings).toEqual(expect.arrayContaining([expect.objectContaining({ courseId, memoryIds: [memoryId] })]));
    await db.query("UPDATE opening_assistant_candidates SET source_turn_id=$1 WHERE id=$2", [userTurnId,candidateId]);
    await expect(jobs.loadCompletedTurnForMetadata({ scope, jobId, assistantTurnId })).resolves.toMatchObject({ answer: restoredAnswer });
    const leaseId = "ab000000-0000-4000-8000-000000000009";
    const leaseToken = "ab000000-0000-4000-8000-000000000010";
    const metadataPayload = { tutorJobId: jobId, assistantTurnId, tutorClaimToken: null };
    await db.query("INSERT INTO opening_jobs VALUES ($1,$2,$3,'tutor-metadata','running',$4,7,$5)",
      [leaseId,scope.workspaceId,scope.ownerUserId,leaseToken,metadataPayload]);
    const provider = vi.fn(async () => ({ text: "metadata", requestId: null, citedChunkIds: [], candidates: [],
      inputTokens: 1, outputTokens: 1 }));
    const metadata = createTutorMetadataHandler({ tutorJobs: jobs, async callModel(_scope, _mode, options) {
      const output = await options.authorizeAndStartSend!(provider);
      await options.persistResult!(output, { reservationId: leaseId, settledCents: null });
      return output;
    } });
    const runMetadata = () => metadata({ ...scope, id: leaseId, claimToken: leaseToken, privacyEpoch: 7 } as never, metadataPayload);
    await expect(runMetadata()).resolves.toEqual({ skipped: false, appended: true });
    expect(provider).toHaveBeenCalledOnce();
    const sendJob = "ab000000-0000-4000-8000-000000000001";
    await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,status) VALUES ($1,$2,$3,$4,'running')",
      [sendJob,scope.workspaceId,jobId,currentUser]);
    const send = vi.fn(async () => "sent");
    const authorization = { contextSourceRefs: history.sourceRefs, globalMemoryIds: history.memoryIds,
      historyCourseBindings: history.historyCourseBindings, historyMisconceptionLineage: history.historyMisconceptionLineage,
      temporaryMemoryExpiresAt: history.temporaryMemoryExpiresAt };
    await expect(jobs.authorizeSend(scope, sendJob, authorization, send)).resolves.toBe("sent");
    await db.query("UPDATE opening_memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [memoryId]);
    await expect(loadTutorHistoryContext(sql, scope, currentUser)).resolves.toMatchObject({ history: [] });
    await expect(jobs.authorizeSend(scope, sendJob, authorization, send)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(send).toHaveBeenCalledOnce();
    await expect(runMetadata()).resolves.toEqual({ skipped: true });
    expect(provider).toHaveBeenCalledOnce();
    await db.query("UPDATE opening_assistant_candidates SET source_turn_id=$1 WHERE id=$2", [assistantTurnId,candidateId]);
    await expect(admitTaskCandidate(sql as never, scope, candidateId)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(assertTaskCandidateMemoryDependencies(sql as never, scope.workspaceId, assistantTurnId))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [assistantTurnId], courseId)).resolves.toBe(false);
    await expect(repo.listTurns(scope, jobId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: assistantTurnId, text: restoredAnswer }),
    ]));
    await db.query("UPDATE opening_memories SET expires_at=$1 WHERE id=$2", [expiry,memoryId]);
    await db.query("UPDATE v3_bitemporal_misconception_edges SET status='retracted'");
    await expect(read()).resolves.toEqual([{ hidden: true }]);
    await expect(readMemoryMisconceptionLineages(sql, scope, [derivedMemory], courseId)).resolves.toEqual(new Map());
    await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [assistantTurnId], courseId)).resolves.toBe(false);
    const recordAnswer = "ab000000-0000-4000-8000-000000000002";
    const recordQuestion = "ab000000-0000-4000-8000-000000000003";
    const recordTarget = "ab000000-0000-4000-8000-000000000004";
    const receipt = { authorization: { purpose: "system_record_lookup", workspaceId: scope.workspaceId,
      principalId: scope.ownerUserId, role: "workspace_owner", permissionRevision: "owner-fixture" },
    version: "study-query-v1", asOf: "2026-11-23T12:00:00Z", privacyEpoch: 7, mode: "deterministic", status: "ok",
    reason: "read", results: [] };
    await db.query("UPDATE opening_turns SET intent_hash=$1,context_source_refs=$2 WHERE id=$3",
      [JSON.stringify(exact), JSON.stringify([{ memoryDependencyIds: [memoryId] }]), assistantTurnId]);
    await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,context_source_refs,
        query_system,system_query,created_at,text)
      VALUES ($1,$4,$5,'user','complete','[]',true,NULL,now()-interval '20 seconds','Find the newer result'),
        ($2,$4,$5,'assistant','complete','[]',true,$6,now()-interval '10 seconds','Record answer'),
        ($3,$4,$5,'user','complete','[]',true,NULL,now()+interval '1 second','What about that result?')`,
      [recordQuestion,recordAnswer,recordTarget,scope.workspaceId,jobId,receipt]);
    await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$5)",
      [recordAnswer,scope.workspaceId,jobId,recordQuestion,recordAnswer]);
    await db.query("UPDATE v3_bitemporal_misconception_edges SET status='candidate'");
    const recordBeforeWithdrawal = await loadTutorHistoryContext(sql, scope, recordTarget, "record_referents");
    expect(recordBeforeWithdrawal.history).toContainEqual({ role: "user", text: "Find the newer result" });
    expect(recordBeforeWithdrawal.history.every(turn => turn.role === "user")).toBe(true);
    await db.query("UPDATE v3_bitemporal_misconception_edges SET status='retracted'");
    const recordHistory = await loadTutorHistoryContext(sql, scope, recordTarget, "record_referents");
    expect(recordHistory.history).toContainEqual({ role: "user", text: "Find the newer result" });
    expect(recordHistory.history.every(turn => turn.role === "user")).toBe(true);

    const sourceId = "ab000000-0000-4000-8000-000000000005";
    const legacyConversation = "ab000000-0000-4000-8000-000000000006";
    const legacyQuestion = "ab000000-0000-4000-8000-000000000011";
    const legacyTarget = "ab000000-0000-4000-8000-000000000012";
    const legacyAssistant = "ab000000-0000-4000-8000-000000000007";
    const legacyId = "ab000000-0000-4000-8000-000000000008";
    await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,NULL)", [legacyConversation,scope.workspaceId,scope.ownerUserId]);
    await db.query("INSERT INTO opening_sources (id,workspace_id,version,upload_state) VALUES ($1,$2,1,'uploaded')", [sourceId,scope.workspaceId]);
    await db.query("UPDATE opening_conversations SET course_id=NULL WHERE id=$1", [originConversation]);
    await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=NULL,status='candidate'");
    await db.query("UPDATE opening_turns SET intent_hash=$1,context_source_refs=$2,source_ids=ARRAY[$3]::uuid[] WHERE id=$4",
      [JSON.stringify(usedLineage), [{sourceId,sourceVersion:1}], sourceId, originId]);
    await db.query("UPDATE opening_memories SET course_id=NULL,kind='confirmed',expires_at=NULL WHERE id=ANY($1::uuid[])",
      [[memoryId,derivedMemory]]);
    await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,context_source_refs,query_system,created_at,text)
      VALUES ($1,$3,$4,'assistant','complete',$5,false,now()-interval '2 seconds','Legacy origin'),
        ($2,$3,$4,'assistant','complete','[]',false,now()-interval '1 second','Legacy follow-up')`,
      [legacyId,legacyAssistant,scope.workspaceId,legacyConversation,[{sourceId,sourceVersion:1,memoryOnly:true}]]);
    await db.query("UPDATE opening_memories SET source_turn_ids=$1 WHERE id=$2", [[legacyAssistant],derivedMemory]);
    await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,context_source_refs,query_system,created_at,text)
      VALUES ($1,$3,$4,'user','complete','[]',false,now()-interval '1500 milliseconds','Question with legacy context'),
        ($2,$3,$4,'user','complete','[]',false,now(),'Next legacy question')`,
      [legacyQuestion,legacyTarget,scope.workspaceId,legacyConversation]);
    await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$1)",
      [legacyAssistant,scope.workspaceId,legacyConversation,legacyQuestion]);
    await expect(loadTutorHistoryContext(sql, scope, legacyTarget)).resolves.toMatchObject({
      history: [{ role: "user", text: "Question with legacy context" }, { role: "assistant", text: "Legacy follow-up" }],
      memoryIds: [memoryId], historyMisconceptionLineage: usedLineage,
    });
    await expect(readMemoryMisconceptionLineages(sql, scope, [derivedMemory], null)).resolves.toEqual(new Map([[derivedMemory,usedLineage]]));
    await expect(repo.releaseReturnedTurnIds(scope, legacyConversation, [legacyAssistant])).resolves.toEqual([
      {id:legacyAssistant,role:"assistant",text:"Legacy follow-up",citations:[]},
    ]);
    await db.query("UPDATE v3_bitemporal_misconception_edges SET status='retracted'");
    await expect(repo.releaseReturnedTurnIds(scope, legacyConversation, [legacyAssistant])).resolves.toEqual([
      {id:legacyAssistant,role:"assistant",text:unavailable,citations:[]},
    ]);
    await expect(readMemoryMisconceptionLineages(sql, scope, [derivedMemory], null)).resolves.toEqual(new Map());
    await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [legacyAssistant], null)).resolves.toBe(false);
    await expect(loadTutorHistoryContext(sql, scope, legacyTarget)).resolves.toMatchObject({ history: [] });
    await db.query("UPDATE opening_assistant_candidates SET source_turn_id=$1,conversation_id=$2 WHERE id=$3",
      [legacyAssistant,legacyConversation,candidateId]);
    await expect(admitTaskCandidate(sql as never, scope, candidateId)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(repo.listTurns(scope, legacyConversation)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: legacyAssistant, text: unavailable }),
    ]));

    // Round-8 P1 #1: Paired user turn memory references (exact IDs and legacy memoryOnly) on an assistant origin
    // whose own context_source_refs is empty, while keeping user-turn SHA-256 intent_hash untouched.
    const pairedConversation = "ac000000-0000-4000-8000-000000000001";
    const pairedUser = "ac000000-0000-4000-8000-000000000002";
    const pairedAssistant = "ac000000-0000-4000-8000-000000000003";
    const pairedDerivedMemory = "ac000000-0000-4000-8000-000000000004";
    const pairedCandidateId = "ac000000-0000-4000-8000-000000000005";
    await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,$4)",
      [pairedConversation, scope.workspaceId, scope.ownerUserId, courseId]);
    await db.query("UPDATE opening_conversations SET course_id=$1 WHERE id=$2", [courseId, originConversation]);
    await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=$1,status='candidate'", [courseId]);
    await db.query("UPDATE opening_turns SET intent_hash=$1,context_source_refs='[]',source_ids='{}' WHERE id=$2",
      [JSON.stringify(exact), originId]);
    await db.query("UPDATE opening_memories SET course_id=$1,kind='confirmed',expires_at=NULL WHERE id=$2", [courseId, memoryId]);
    await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
        context_anchor,query_system,created_at,text)
      VALUES ($1,$3,$4,'user','complete','sha256:user-request-intent-hash',$5,$6,false,now()-interval '2 seconds','Paired user question'),
        ($2,$3,$4,'assistant','complete',NULL,'[]',$6,false,now()-interval '1 second','Paired assistant answer')`,
      [pairedUser, pairedAssistant, scope.workspaceId, pairedConversation,
        JSON.stringify([{ memoryDependencyIds: [memoryId] }]), JSON.stringify({ courseId })]);
    await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$5)",
      [pairedAssistant, scope.workspaceId, pairedConversation, pairedUser, pairedAssistant]);
    await db.query("INSERT INTO opening_memories(id,workspace_id,course_id,source_turn_ids) VALUES ($1,$2,$3,$4)",
      [pairedDerivedMemory, scope.workspaceId, courseId, JSON.stringify([pairedAssistant])]);
    await db.query("INSERT INTO opening_assistant_candidates VALUES ($1,$2,$3,$4,'[]',$5)",
      [pairedCandidateId, scope.workspaceId, pairedConversation, pairedAssistant,
        { kind: "task", title: "Paired follow-up", minutes: 15, dueText: null }]);
    await db.exec("ANALYZE");
    await expect(readMemoryMisconceptionLineages(sql, scope, [pairedDerivedMemory], courseId))
      .resolves.toEqual(new Map([[pairedDerivedMemory, exact]]));
    await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [pairedAssistant], courseId)).resolves.toBe(true);
    await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [pairedAssistant], null)).resolves.toBe(false);
    await expect(admitTaskCandidate(sql as never, scope, pairedCandidateId)).resolves.toBe(pairedAssistant);
    await expect(repo.releaseReturnedTurnIds(scope, pairedConversation, [pairedAssistant])).resolves.toEqual([
      { id: pairedAssistant, role: "assistant", text: "Paired assistant answer", citations: [] },
    ]);
    await db.query("UPDATE v3_bitemporal_misconception_edges SET status='retracted'");
    await expect(readMemoryMisconceptionLineages(sql, scope, [pairedDerivedMemory], courseId)).resolves.toEqual(new Map());
    await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [pairedAssistant], courseId)).resolves.toBe(false);
    await expect(admitTaskCandidate(sql as never, scope, pairedCandidateId)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(repo.releaseReturnedTurnIds(scope, pairedConversation, [pairedAssistant])).resolves.toEqual([
      { id: pairedAssistant, role: "assistant", text: unavailable, citations: [] },
    ]);
    await expect(repo.listTurns(scope, pairedConversation)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pairedAssistant, text: unavailable }),
    ]));
    await expect(repo.listSummaries(scope)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pairedConversation, lastTurnPreview: unavailable }),
    ]));
    // Legacy memoryOnly: true on pairedUser also propagates and redacts after withdrawal.
    await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=NULL,status='candidate'");
    await db.query("UPDATE opening_conversations SET course_id=NULL WHERE id=ANY($1::uuid[])", [[originConversation, pairedConversation]]);
    await db.query("UPDATE opening_turns SET intent_hash=$1,context_source_refs=$2,source_ids=ARRAY[$3]::uuid[] WHERE id=$4",
      [JSON.stringify(usedLineage), JSON.stringify([{ sourceId, sourceVersion: 1 }]), sourceId, originId]);
    await db.query("UPDATE opening_memories SET course_id=NULL WHERE id=ANY($1::uuid[])", [[memoryId, pairedDerivedMemory]]);
    await db.query("UPDATE opening_turns SET context_anchor=NULL,context_source_refs=$1 WHERE id=$2",
      [JSON.stringify([{ sourceId, sourceVersion: 1, memoryOnly: true }]), pairedUser]);
    await db.query("UPDATE opening_turns SET context_anchor=NULL WHERE id=$1", [pairedAssistant]);
    await expect(readMemoryMisconceptionLineages(sql, scope, [pairedDerivedMemory], null))
      .resolves.toEqual(new Map([[pairedDerivedMemory, usedLineage]]));
    await db.query("UPDATE v3_bitemporal_misconception_edges SET status='retracted'");
    await expect(readMemoryMisconceptionLineages(sql, scope, [pairedDerivedMemory], null)).resolves.toEqual(new Map());
    await expect(sourceTurnsAllowMisconceptionMemory(sql, scope, [pairedAssistant], null)).resolves.toBe(false);
    await expect(admitTaskCandidate(sql as never, scope, pairedCandidateId)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(repo.releaseReturnedTurnIds(scope, pairedConversation, [pairedAssistant])).resolves.toEqual([
      { id: pairedAssistant, role: "assistant", text: unavailable, citations: [] },
    ]);

    // Round-8 P1 #2: Confirmed memory M_conf derived from hashless follow-up a1 whose jobless predecessor prior_a
    // used temporary memory M_temp (expires_at = T). Both loadTutorHistoryContext and loadMemoryContext propagate
    // M_temp, its course binding, and T, and delaying authorizeSend across T rejects before startSend().
    const chainConversation = "ad000000-0000-4000-8000-000000000001";
    const chainBareOrigin = "ad000000-0000-4000-8000-000000000002";
    const chainJoblessPrior = "ad000000-0000-4000-8000-000000000003";
    const chainFollowUpUser = "ad000000-0000-4000-8000-000000000004";
    const chainFollowUpAssistant = "ad000000-0000-4000-8000-000000000005";
    const chainConsumerConv = "ad000000-0000-4000-8000-000000000006";
    const chainConsumerUser = "ad000000-0000-4000-8000-000000000007";
    const chainConsumerAssistant = "ad000000-0000-4000-8000-000000000008";
    const chainNextUser = "ad000000-0000-4000-8000-000000000009";
    const chainSendJob = "ad000000-0000-4000-8000-000000000010";
    const mTemp = "ad000000-0000-4000-8000-000000000011";
    const mConf = "ad000000-0000-4000-8000-000000000012";
    await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=$1,status='candidate'", [courseId]);
    await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,$4), ($5,$2,$3,$4)",
      [chainConversation, scope.workspaceId, scope.ownerUserId, courseId, chainConsumerConv]);
    const shortExpiry = new Date(Date.now() + 2_500).toISOString();
    await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
        context_anchor,query_system,created_at,text)
      VALUES ($1,$7,$8,'assistant','complete',$10,'[]',$12,false,now()-interval '4 minutes','Temp origin'),
        ($2,$7,$8,'assistant','complete',NULL,$11,$12,false,now()-interval '3 minutes','Jobless prior using M_temp'),
        ($3,$7,$8,'user','complete',NULL,'[]',$12,false,now()-interval '2 minutes','Follow-up question'),
        ($4,$7,$8,'assistant','complete',NULL,'[]',$12,false,now()-interval '90 seconds','Hashless a1'),
        ($5,$7,$9,'user','complete',NULL,'[]',$12,false,now()-interval '60 seconds','Consumer question'),
        ($6,$7,$9,'assistant','complete',NULL,$13,$12,false,now()-interval '30 seconds','Answer using M_conf')`,
      [chainBareOrigin, chainJoblessPrior, chainFollowUpUser, chainFollowUpAssistant, chainConsumerUser, chainConsumerAssistant,
        scope.workspaceId, chainConversation, chainConsumerConv, JSON.stringify(exact),
        JSON.stringify([{ memoryDependencyIds: [mTemp] }]), JSON.stringify({ courseId }),
        JSON.stringify([{ memoryDependencyIds: [mConf] }])]);
    await db.query("INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,context_source_refs,context_anchor,query_system,created_at,text) VALUES ($1,$2,$3,'user','complete','[]',$4,false,now(),'Delayed send question')",
      [chainNextUser, scope.workspaceId, chainConsumerConv, JSON.stringify({ courseId })]);
    await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$5), ($6,$2,$7,$8,$9)",
      [chainFollowUpAssistant, scope.workspaceId, chainConversation, chainFollowUpUser, chainFollowUpAssistant,
        chainConsumerAssistant, chainConsumerConv, chainConsumerUser, chainConsumerAssistant]);
    await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,status) VALUES ($1,$2,$3,$4,'running')",
      [chainSendJob, scope.workspaceId, chainConsumerConv, chainNextUser]);
    await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at,text) VALUES ($1,$3,$4,$5,'temporary',$7,'Temporary predecessor'), ($2,$3,$4,$6,'confirmed',NULL,'Confirmed derivative')",
      [mTemp, mConf, scope.workspaceId, courseId, JSON.stringify([chainBareOrigin]), JSON.stringify([chainFollowUpAssistant]), shortExpiry]);
    await db.exec("ANALYZE");
    const chainHistory = await loadTutorHistoryContext(sql, scope, chainNextUser);
    expect(chainHistory.history.map(t => t.text)).toEqual(["Consumer question", "Answer using M_conf"]);
    expect(chainHistory.memoryIds).toEqual(expect.arrayContaining([mConf, mTemp]));
    expect(chainHistory.temporaryMemoryExpiresAt).toBe(shortExpiry);
    expect(chainHistory.historyCourseBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ courseId, memoryIds: expect.arrayContaining([mConf, mTemp]) }),
    ]));
    const loadedMemoryCtx = await createOpeningMemoryRepository(sql).listContext(scope, new Date().toISOString(), courseId);
    expect(loadedMemoryCtx.memories.map(m => m.id)).toContain(mConf);
    expect(loadedMemoryCtx.dependencyMemoryIds).toContain(mTemp);
    expect(loadedMemoryCtx.temporaryMemoryExpiresAt).toBe(shortExpiry);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(shortExpiry) - Date.now()) + 120));
    const delayedStartSend = vi.fn(async () => "should-never-send");
    await expect(jobs.authorizeSend(scope, chainSendJob, {
      contextSourceRefs: chainHistory.sourceRefs,
      globalMemoryIds: chainHistory.memoryIds,
      historyCourseBindings: chainHistory.historyCourseBindings,
      historyMisconceptionLineage: chainHistory.historyMisconceptionLineage,
      temporaryMemoryExpiresAt: chainHistory.temporaryMemoryExpiresAt,
    }, delayedStartSend)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.authorizeSend(scope, chainSendJob, {
      contextSourceRefs: loadedMemoryCtx.sourceRefs,
      globalMemoryIds: [mConf, ...(loadedMemoryCtx.dependencyMemoryIds ?? [])],
      misconceptionSnapshot: undefined,
      historyMisconceptionLineage: loadedMemoryCtx.misconceptionLineage,
      temporaryMemoryExpiresAt: loadedMemoryCtx.temporaryMemoryExpiresAt,
    }, delayedStartSend)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.authorizeSend(scope, chainSendJob, {
      contextSourceRefs: [],
      globalMemoryIds: [mConf],
      historyMisconceptionLineage: loadedMemoryCtx.misconceptionLineage,
    }, delayedStartSend)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(delayedStartSend).not.toHaveBeenCalled();

    expect(plans.length).toBeGreaterThan(0);
  } finally {
    await db.close();
  }
}, 30_000);