import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";
import { createTutorMetadataHandler } from "../../../../apps/worker/src/jobs/tutor-metadata";
import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";
import { loadTutorHistoryContext, readTutorHistoryAncestorAuthority, readTutorHistoryAncestorStatus } from "./opening-tutor-history";
import { createOpeningConversationRepository } from "./opening-conversations";
import { releaseOpeningStudyExposure } from "./opening-study-exposure";
import { createOpeningMemoryRepository } from "./opening-memory";
import { admitTaskCandidate, assertTaskCandidateMemoryDependencies } from "./opening-task-candidate-admission";
import { sqlSimulation, unexpected } from "./opening-resident-f11-sql-simulation";
import { assertTutorAttemptContext, readTutorAttemptContext, tutorAttemptFence } from "./opening-tutor-attempt-context";
import {
  assertTutorLearnerMisconceptionSnapshot, readMemoryMisconceptionLineages, readTurnMisconceptionMemoryOrigins,
  readTurnsWithInvalidMisconceptionMemories, readTutorLearnerMisconceptionContext, sourceTurnsAllowMisconceptionMemory,
  turnUsesInactiveMisconception, type TutorMisconceptionSnapshot,
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

it("preserves multi-turn conv_misconception_hashes, jobless course scope, paired-user misconception course, and omitted exchange memory IDs", async () => {
  const convId = "c1000000-0000-4000-8000-000000000001";
  const u0 = "c1000000-0000-4000-8000-000000000010";
  const a0 = "c1000000-0000-4000-8000-000000000011";
  const u1 = "c1000000-0000-4000-8000-000000000012";
  const a1 = "c1000000-0000-4000-8000-000000000013";
  const u2 = "c1000000-0000-4000-8000-000000000014";
  const a2 = "c1000000-0000-4000-8000-000000000015";
  const memScopedA = "c1000000-0000-4000-8000-000000000020";
  const memMiscA = "c1000000-0000-4000-8000-000000000021";
  const courseALineage = { kind: "v3_misconception_lineage" as const, courseId, revisionIds: [candidate.revisionId] };

  // 1) Step-2 P1 #0: conv_misconception_hashes attached only to u2's row must still invalidate hashless u1 when u2 is explicit.
  {
    const convHashes = [{ posUs: "100", posId: u0, assistantId: a0, hash: JSON.stringify(usedLineage) }];
    const baseRow = {
      conversation_id: convId, user_source_refs: [], assistant_source_refs: [],
      assistant_direct_versioned: true, origin_allowed: true, current_allowed: true, current_course_id: null,
    };
    const { sql } = sqlSimulation(({ text, values }) => {
      if (text.startsWith("WITH prior AS MATERIALIZED")) {
        return [
          // Only u2's rows carry conv_misconception_hashes; u1's prior row has conv_misconception_hashes: null.
          { ...baseRow, current_id: u2, id: u2, assistant_id: a2, pos_us: "300", assistant_intent_hash: JSON.stringify(cleanLineage), conv_misconception_hashes: convHashes },
          { ...baseRow, current_id: u2, id: u1, assistant_id: a1, pos_us: "200", assistant_intent_hash: null, conv_misconception_hashes: convHashes },
          { ...baseRow, current_id: u1, id: u0, assistant_id: a0, pos_us: "150", assistant_intent_hash: null, conv_misconception_hashes: null },
        ];
      }
      if (text.startsWith("WITH tick AS MATERIALIZED")) {
        const bound = values[0] as Array<{ position: number; revision_ids: string[] }>;
        // Withdraw usedLineage; keep cleanLineage active.
        return bound.filter(l => l.revision_ids.length === 0);
      }
      return [];
    });
    const auth = await readTutorHistoryAncestorAuthority(sql, scope, [u1, u2]);
    expect(auth.get(u2)).not.toBeNull();
    expect(auth.get(u1)).toBeNull();
  }

  // 2) Step-1 P1 #1 & #3: Jobless Course-A ordinary memory blocks Course-B derivative reuse; omitted job-backed exchange preserves memoryIds.
  {
    let targetCourse: string | null = otherCourseId;
    let exchangeQuestion = "Follow-up Q";
    let priorHasJob = false;
    const { sql } = sqlSimulation(({ text, values }) => {
      if (text.startsWith("WITH prior AS MATERIALIZED")) {
        const hashlessRow = {
          conversation_id: convId, current_id: u2, id: u1, assistant_id: a1, pos_us: "200",
          question: exchangeQuestion, answer: "Hashless derivative",
          prior_course_id: courseId, assistant_course_id: courseId, current_course_id: targetCourse,
          material_use: "citation", prior_material_use: "citation", assistant_material_use: "citation",
          assistant_intent_hash: null, inherits_memory: !priorHasJob,
          user_source_refs: [], assistant_source_refs: [], user_direct_ids: [], assistant_direct_ids: [],
          memory_backing_ids: [], user_memory_backing_ids: [],
          assistant_direct_versioned: true, origin_allowed: true, current_allowed: true,
          conv_misconception_hashes: [],
        };
        if (!priorHasJob) return [hashlessRow];
        return [
          hashlessRow,
          {
            ...hashlessRow, id: u0, assistant_id: a0, pos_us: "100",
            question: "x".repeat(12_000), answer: "Older job-backed memory answer",
            assistant_source_refs: [{ memoryDependencyIds: [memScopedA] }],
            inherits_memory: false,
          },
        ];
      }
      if (text.startsWith("SELECT t.id, ARRAY(")) {
        return [{
          id: a1, origins: [], conversation_id: convId, consumer_course_id: courseId,
          pos_us: "200", pos_id: u1, inherits_prefix: true,
          conv_origins: [{
            posUs: "100", posId: a0,
            origin: {
              id: a0, assistantTurnId: a0, courseId, consumerCourseId: null, materialUse: "citation",
              refs: [{ memoryDependencyIds: [memScopedA] }], standalone: false, historical: true, jobBacked: false,
            },
          }],
        }];
      }
      if (text.startsWith("SELECT dep_m.id, dep_m.course_id")) {
        return [{ id: memScopedA, course_id: courseId, source_turn_ids: [], expires_at: null }];
      }
      if (text.startsWith("SELECT m.id, course.id AS turn_course_id")) return [];
      if (text.startsWith("SELECT id FROM courses")) return [{ id: courseId }, { id: otherCourseId }];
      if (text.startsWith("SELECT id FROM opening_memories")) {
        return [{ id: { memoryId: memScopedA, hashes: [], courseId, active: true, origins: [] } }];
      }
      if (text.startsWith("WITH tick AS MATERIALIZED")) return values[0] as unknown[];
      return [];
    });
    expect((await loadTutorHistoryContext(sql, scope, u2)).history).toEqual([]);
    targetCourse = null;
    expect((await loadTutorHistoryContext(sql, scope, u2)).history).toEqual([]);
    targetCourse = courseId;
    const validCourseA = await loadTutorHistoryContext(sql, scope, u2);
    expect(validCourseA.history).toHaveLength(2);
    expect(validCourseA.memoryIds).toEqual([memScopedA]);

    // Step-1 P1 #3: When older job-backed exchange is omitted by 12,000-character budget, retained hashless exchange keeps memScopedA.
    priorHasJob = true;
    exchangeQuestion = "Short follow-up";
    const omittedJobBacked = await loadTutorHistoryContext(sql, scope, u2);
    expect(omittedJobBacked.history.map(t => t.text)).toEqual(["Short follow-up", "Hashless derivative"]);
    expect(omittedJobBacked.memoryIds).toEqual([memScopedA]);
  }

  // 3) Step-1 P1 #2: Paired user memory with Course-A misconception + Course-B assistant is rejected in own & ancestor checks.
  {
    let useMisconceptionMemory = true;
    const { sql } = sqlSimulation(({ text, values }) => {
      const memId = useMisconceptionMemory ? memMiscA : memScopedA;
      if (text.startsWith("WITH prior AS MATERIALIZED")) {
        return [{
          conversation_id: convId, current_id: u2, id: u1, assistant_id: a1, pos_us: "100",
          question: "Course A user Q", answer: "Course B assistant A",
          prior_course_id: courseId, assistant_course_id: otherCourseId, current_course_id: courseId,
          material_use: "citation", prior_material_use: "citation", assistant_material_use: "citation",
          assistant_intent_hash: JSON.stringify(cleanLineage), inherits_memory: false,
          user_source_refs: [{ memoryDependencyIds: [memId] }], assistant_source_refs: [],
          user_direct_ids: [], assistant_direct_ids: [],
          memory_backing_ids: [], user_memory_backing_ids: [],
          assistant_direct_versioned: true, origin_allowed: true, current_allowed: true,
          conv_misconception_hashes: [],
        }];
      }
      if (text.startsWith("SELECT dep_m.id, dep_m.course_id")) {
        return [{ id: memId, course_id: courseId, source_turn_ids: [], expires_at: null }];
      }
      if (text.startsWith("SELECT m.id, course.id AS turn_course_id")) return [];
      if (text.startsWith("SELECT id FROM courses")) return [{ id: courseId }, { id: otherCourseId }];
      if (text.startsWith("SELECT id FROM opening_memories")) {
        return [{
          id: {
            memoryId: memId,
            hashes: useMisconceptionMemory ? [JSON.stringify(courseALineage)] : [],
            courseId,
            active: true,
            origins: [],
          },
        }];
      }
      if (text.startsWith("WITH tick AS MATERIALIZED")) return values[0] as unknown[];
      return [];
    });
    expect((await loadTutorHistoryContext(sql, scope, u2)).history).toEqual([]);
    expect((await readTutorHistoryAncestorStatus(sql, scope, u2)).valid).toBe(false);
    expect((await readTutorHistoryAncestorStatus(sql, scope, u2, { skipPriorMisconceptions: true })).valid).toBe(false);

    // Ordinary Course-A user memory (no misconception) remains valid when paired user turn was in Course A.
    useMisconceptionMemory = false;
    expect((await loadTutorHistoryContext(sql, scope, u2)).history).toHaveLength(2);
    expect((await readTutorHistoryAncestorStatus(sql, scope, u2)).valid).toBe(true);
  }
});

it("closes Round-12 mixed-course/use isolation, paired-assistant prefix course, expired first-delivery redaction, and O(N) jobless bindings", async () => {
  const unavailable = "关联学习记录已更新或撤回，此回答内容不再显示。";
  const convId = "c2000000-0000-4000-8000-000000000001";
  const memOrdA = "c2000000-0000-4000-8000-000000000010";
  const memCitB = "c2000000-0000-4000-8000-000000000011";
  const memMiscA = "c2000000-0000-4000-8000-000000000012";
  const memTemp = "c2000000-0000-4000-8000-000000000013";
  const memDerivedFromTemp = "c2000000-0000-4000-8000-000000000014";
  const courseALineage = { kind: "v3_misconception_lineage" as const, courseId, revisionIds: [candidate.revisionId] };

  // 1) Round-12 P1 #1: Mixed-course (A/B) and mixed-material-use (citation/practice) hashless exchanges are excluded,
  // while pure destination-isolated (B/B and practice/practice) hashless exchanges remain admitted.
  {
    const joblessA = "c2000000-0000-4000-8000-000000000020";
    const uAA = "c2000000-0000-4000-8000-000000000021";
    const aAA = "c2000000-0000-4000-8000-000000000022";
    const uAB = "c2000000-0000-4000-8000-000000000023";
    const aAB = "c2000000-0000-4000-8000-000000000024";
    const uBB = "c2000000-0000-4000-8000-000000000025";
    const aBB = "c2000000-0000-4000-8000-000000000026";
    const currentB = "c2000000-0000-4000-8000-000000000027";
    let mode: "course" | "practice" = "course";
    const { sql } = sqlSimulation(({ text, values }) => {
      if (text.startsWith("WITH prior AS MATERIALIZED")) {
        if (mode === "course") {
          const base = {
            conversation_id: convId, current_id: currentB, current_course_id: otherCourseId,
            material_use: "citation", prior_material_use: "citation", assistant_material_use: "citation",
            assistant_intent_hash: null, inherits_memory: true,
            user_source_refs: [], assistant_source_refs: [], user_direct_ids: [], assistant_direct_ids: [],
            memory_backing_ids: [], user_memory_backing_ids: [],
            assistant_direct_versioned: true, origin_allowed: true, current_allowed: true, conv_misconception_hashes: [],
          };
          return [
            { ...base, id: uBB, assistant_id: aBB, pos_us: "400", prior_course_id: otherCourseId, assistant_course_id: otherCourseId, question: "Pure B Q", answer: "Pure B A" },
            { ...base, id: uAB, assistant_id: aAB, pos_us: "300", prior_course_id: courseId, assistant_course_id: otherCourseId, question: "Mixed A/B Q", answer: "Mixed A/B A" },
            { ...base, id: uAA, assistant_id: aAA, pos_us: "200", prior_course_id: courseId, assistant_course_id: courseId, question: "Pure A Q", answer: "Pure A A" },
          ];
        }
        const base = {
          conversation_id: convId, current_id: currentB, current_course_id: otherCourseId,
          prior_course_id: otherCourseId, assistant_course_id: otherCourseId,
          material_use: "practice", assistant_intent_hash: null, inherits_memory: true,
          user_source_refs: [], assistant_source_refs: [], user_direct_ids: [], assistant_direct_ids: [],
          memory_backing_ids: [], user_memory_backing_ids: [],
          assistant_direct_versioned: true, origin_allowed: true, current_allowed: true, conv_misconception_hashes: [],
        };
        return [
          { ...base, id: uBB, assistant_id: aBB, pos_us: "400", prior_material_use: "practice", assistant_material_use: "practice", question: "Pure practice Q", answer: "Pure practice A" },
          { ...base, id: uAB, assistant_id: aAB, pos_us: "300", prior_material_use: "citation", assistant_material_use: "practice", question: "Mixed cit/prac Q", answer: "Mixed cit/prac A" },
          { ...base, id: uAA, assistant_id: aAA, pos_us: "200", prior_material_use: "citation", assistant_material_use: "citation", question: "Pure cit Q", answer: "Pure cit A" },
        ];
      }
      if (text.startsWith("SELECT t.id, ARRAY(")) {
        const memId = mode === "course" ? memOrdA : memCitB;
        const memCourse = mode === "course" ? courseId : otherCourseId;
        return [aBB, aAB, aAA].map((aid, idx) => ({
          id: aid, origins: [], conversation_id: convId, consumer_course_id: otherCourseId,
          pos_us: String(400 - idx * 100), pos_id: [uBB, uAB, uAA][idx]!, inherits_prefix: true,
          conv_origins: idx === 0 ? [{
            posUs: "100", posId: joblessA,
            origin: {
              id: joblessA, assistantTurnId: joblessA, courseId: memCourse, consumerCourseId: null,
              materialUse: "citation", refs: [{ memoryDependencyIds: [memId] }],
              standalone: false, historical: true, jobBacked: false,
            },
          }] : null,
        }));
      }
      if (text.startsWith("SELECT dep_m.id, dep_m.course_id")) {
        const memId = mode === "course" ? memOrdA : memCitB;
        const memCourse = mode === "course" ? courseId : otherCourseId;
        return [{ id: memId, course_id: memCourse, source_turn_ids: mode === "practice" ? [joblessA] : [], expires_at: null }];
      }
      if (text.startsWith("SELECT m.id, course.id AS turn_course_id")) {
        if (mode === "practice" && !values.includes("practice")) {
          return [{ id: memCitB, turn_course_id: otherCourseId, refs: [], backings: [], source_ids: [] }];
        }
        return [];
      }
      if (text.startsWith("SELECT id FROM courses")) return [{ id: courseId }, { id: otherCourseId }];
      if (text.startsWith("SELECT id FROM opening_memories")) {
        const memId = mode === "course" ? memOrdA : memCitB;
        const memCourse = mode === "course" ? courseId : otherCourseId;
        return [{ id: { memoryId: memId, hashes: [], courseId: memCourse, active: true, unexpired: true, origins: [] } }];
      }
      if (text.startsWith("WITH tick AS MATERIALIZED")) return values[0] as unknown[];
      return [];
    });
    const resCourse = await loadTutorHistoryContext(sql, scope, currentB);
    expect(resCourse.history.map(t => t.text)).toEqual(["Pure B Q", "Pure B A"]);
    expect(resCourse.memoryIds).toBeUndefined();

    mode = "practice";
    const resPractice = await loadTutorHistoryContext(sql, scope, currentB);
    expect(resPractice.history.map(t => t.text)).toEqual(["Pure practice Q", "Pure practice A"]);
    expect(resPractice.memoryIds).toBeUndefined();
  }

  // 2) Round-12 P1 #2: Paired-user Course-A misconception memory + paired-assistant in Course B followed by a hashless Course-A
  // answer: listTurns, listSummaries, and releaseReturnedTurnIds redact the derivative answer and never release its receipt.
  {
    const priorU = "c2000000-0000-4000-8000-000000000031";
    const priorA = "c2000000-0000-4000-8000-000000000032";
    const hashlessU = "c2000000-0000-4000-8000-000000000033";
    const hashlessA = "c2000000-0000-4000-8000-000000000034";
    const receiptId = "c2000000-0000-4000-8000-000000000035";
    const derivedMem = "c2000000-0000-4000-8000-000000000036";
    const { sql, queries } = sqlSimulation(q => {
      const { text } = q;
      if (text.startsWith("SELECT id, title, course_id")) return [{ id: convId, title: "t", course_id: null, updated_at: new Date(at).toISOString() }];
      if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (text.includes("opening_workspace_history_revisions")) return [];
      if (text.startsWith("SELECT c.id,")) {
        return [{
          id: convId, title: "t", course_id: null, updated_at: new Date(at).toISOString(),
          misconception_memory_turn_id: hashlessA, pending_exposure_ids: [receiptId], last_turn_preview: "Hashless Course A derivative",
        }];
      }
      if (text.startsWith("SELECT t.id, t.conversation_id") || text.startsWith("SELECT t.id,t.role")) {
        return [{
          id: hashlessA, conversation_id: convId, role: "assistant", mode: "hint", status: "complete",
          created_at: new Date(at).toISOString(), text: "Hashless Course A derivative", citations: [],
          misconception_memory_turn_id: hashlessA, pending_exposure_ids: [receiptId],
          exposure_receipt: { id: receiptId, released_at: null },
        }];
      }
      if (text.startsWith("SELECT t.id, ARRAY(")) {
        return [{
          id: hashlessA, origins: [], conversation_id: convId, consumer_course_id: courseId,
          pos_us: "200", pos_id: hashlessU, inherits_prefix: true,
          conv_origins: [{
            posUs: "100", posId: priorU,
            origin: {
              id: priorU, assistantTurnId: priorA, courseId, consumerCourseId: null,
              pairedAssistantCourseId: otherCourseId, materialUse: "citation",
              refs: [{ memoryDependencyIds: [memMiscA] }], standalone: false, historical: true, jobBacked: true, isPairedUser: true,
            },
          }],
        }];
      }
      if (text.startsWith("SELECT id FROM opening_memories")) {
        const requested = (q.values[1] as string[]) ?? [];
        if (requested.includes(derivedMem)) {
          return [{
            id: {
              memoryId: derivedMem, hashes: [], courseId, active: true, unexpired: true,
              origins: [{
                id: priorU, assistantTurnId: priorA, courseId, consumerCourseId: courseId,
                pairedAssistantCourseId: otherCourseId, materialUse: "citation",
                refs: [{ memoryDependencyIds: [memMiscA] }], standalone: false, historical: true, jobBacked: true, isPairedUser: true,
              }],
            },
          }];
        }
        return [{ id: { memoryId: memMiscA, hashes: [JSON.stringify(courseALineage)], courseId, active: true, unexpired: true, origins: [] } }];
      }
      return unexpected(q);
    });
    const repo = createOpeningConversationRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
    const turns = await repo.listTurns(scope, convId);
    expect(turns).toMatchObject([{ id: hashlessA, text: unavailable }]);
    expect(turns[0]?.exposureReceipt).toBeUndefined();
    expect(await repo.listSummaries(scope)).toMatchObject([{ id: convId, lastTurnPreview: unavailable }]);
    expect(await repo.releaseReturnedTurnIds(scope, convId, [hashlessA])).toEqual([{ id: hashlessA, role: "assistant", text: unavailable, citations: [] }]);
    expect(queries.some(q => q.text.startsWith("UPDATE opening_help_exposures"))).toBe(false);
    expect(await readMemoryMisconceptionLineages(sql, scope, [derivedMem], courseId)).toEqual(new Map());
  }

  // 3) Round-12 P1 #3: Temporary memory expiry before first delivery redacts direct, transitive-memory, and hashless-prefix
  // answers and never releases their pending exposure receipts, while already-delivered answers remain visible after expiry.
  {
    const tDirectUnreleased = "c2000000-0000-4000-8000-000000000041";
    const tTransitiveUnreleased = "c2000000-0000-4000-8000-000000000042";
    const tPrefixUnreleased = "c2000000-0000-4000-8000-000000000043";
    const tAlreadyReleased = "c2000000-0000-4000-8000-000000000044";
    const rDirect = "c2000000-0000-4000-8000-000000000045";
    const rTransitive = "c2000000-0000-4000-8000-000000000046";
    const rPrefix = "c2000000-0000-4000-8000-000000000047";
    const rReleased = "c2000000-0000-4000-8000-000000000048";
    const releasedIso = new Date(at).toISOString();
    const expiredIso = new Date(Date.now() - 5_000).toISOString();
    const { sql, queries } = sqlSimulation(q => {
      const { text } = q;
      if (text.startsWith("SELECT id, title, course_id")) return [{ id: convId, title: "t", course_id: courseId, updated_at: releasedIso }];
      if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (text.includes("opening_workspace_history_revisions")) return [];
      if (text.startsWith("SELECT c.id,")) {
        return [
          { id: "c2000000-0000-4000-8000-000000000051", title: "d", course_id: courseId, updated_at: releasedIso, misconception_memory_turn_id: tDirectUnreleased, pending_exposure_ids: [rDirect], last_turn_preview: "Direct unreleased" },
          { id: "c2000000-0000-4000-8000-000000000052", title: "tr", course_id: courseId, updated_at: releasedIso, misconception_memory_turn_id: tTransitiveUnreleased, pending_exposure_ids: [rTransitive], last_turn_preview: "Transitive unreleased" },
          { id: "c2000000-0000-4000-8000-000000000053", title: "p", course_id: courseId, updated_at: releasedIso, misconception_memory_turn_id: tPrefixUnreleased, pending_exposure_ids: [rPrefix], last_turn_preview: "Prefix unreleased" },
          { id: "c2000000-0000-4000-8000-000000000054", title: "rel", course_id: courseId, updated_at: releasedIso, misconception_memory_turn_id: tAlreadyReleased, pending_exposure_ids: [], last_turn_preview: "Already delivered" },
        ];
      }
      if (text.startsWith("SELECT t.id, t.conversation_id") || text.startsWith("SELECT t.id,t.role")) {
        return [
          {
            id: tAlreadyReleased, conversation_id: convId, role: "assistant", mode: "hint", status: "complete",
            created_at: releasedIso, text: "Already delivered", citations: [], misconception_memory_turn_id: tAlreadyReleased,
            pending_exposure_ids: [],
            exposure_receipt: {
              id: rReleased, release_key: "rel", context_anchor: { purpose: "learning_help", courseId },
              exposure_origin: "assistant", support_domain: "unknown", generated_at: releasedIso,
              released_at: releasedIso, acknowledged_at: null, history_revision: 1,
            },
          },
          {
            id: tDirectUnreleased, conversation_id: convId, role: "assistant", mode: "hint", status: "complete",
            created_at: releasedIso, text: "Direct unreleased", citations: [], misconception_memory_turn_id: tDirectUnreleased,
            pending_exposure_ids: [rDirect], exposure_receipt: { id: rDirect, released_at: null },
          },
          {
            id: tTransitiveUnreleased, conversation_id: convId, role: "assistant", mode: "hint", status: "complete",
            created_at: releasedIso, text: "Transitive unreleased", citations: [], misconception_memory_turn_id: tTransitiveUnreleased,
            pending_exposure_ids: [rTransitive], exposure_receipt: { id: rTransitive, released_at: null },
          },
          {
            id: tPrefixUnreleased, conversation_id: convId, role: "assistant", mode: "hint", status: "complete",
            created_at: releasedIso, text: "Prefix unreleased", citations: [], misconception_memory_turn_id: tPrefixUnreleased,
            pending_exposure_ids: [rPrefix], exposure_receipt: { id: rPrefix, released_at: null },
          },
        ];
      }
      if (text.startsWith("SELECT t.id, ARRAY(")) {
        return [
          {
            id: tAlreadyReleased, conversation_id: convId, consumer_course_id: courseId, pos_us: "100", pos_id: tAlreadyReleased, inherits_prefix: false,
            origins: [{ id: tAlreadyReleased, assistantTurnId: tAlreadyReleased, courseId, consumerCourseId: courseId, materialUse: "citation", refs: [{ memoryDependencyIds: [memTemp] }], standalone: false }],
            conv_origins: [{
              posUs: "100", posId: tAlreadyReleased,
              origin: { id: tAlreadyReleased, assistantTurnId: tAlreadyReleased, courseId, consumerCourseId: null, materialUse: "citation", refs: [{ memoryDependencyIds: [memTemp] }], standalone: false, historical: true, jobBacked: false },
            }],
          },
          {
            id: tDirectUnreleased, conversation_id: convId, consumer_course_id: courseId, pos_us: "200", pos_id: tDirectUnreleased, inherits_prefix: false,
            origins: [{ id: tDirectUnreleased, assistantTurnId: tDirectUnreleased, courseId, consumerCourseId: courseId, materialUse: "citation", refs: [{ memoryDependencyIds: [memTemp] }], standalone: false }],
            conv_origins: null,
          },
          {
            id: tTransitiveUnreleased, conversation_id: convId, consumer_course_id: courseId, pos_us: "300", pos_id: tTransitiveUnreleased, inherits_prefix: false,
            origins: [{ id: tTransitiveUnreleased, assistantTurnId: tTransitiveUnreleased, courseId, consumerCourseId: courseId, materialUse: "citation", refs: [{ memoryDependencyIds: [memDerivedFromTemp] }], standalone: false }],
            conv_origins: null,
          },
          {
            id: tPrefixUnreleased, conversation_id: convId, consumer_course_id: courseId, pos_us: "400", pos_id: tPrefixUnreleased, inherits_prefix: true,
            origins: [], conv_origins: null,
          },
        ];
      }
      if (text.startsWith("SELECT id FROM opening_memories")) {
        const requested = (q.values[1] as string[]) ?? [];
        return requested.map(id => id === memDerivedFromTemp ? {
          id: {
            memoryId: memDerivedFromTemp, hashes: [], courseId, statusActive: true, unexpired: true, active: true, expiresAt: null,
            origins: [{ id: tAlreadyReleased, assistantTurnId: tAlreadyReleased, courseId, consumerCourseId: courseId, materialUse: "citation", refs: [{ memoryDependencyIds: [memTemp] }], standalone: false }],
          },
        } : {
          id: { memoryId: memTemp, hashes: [], courseId, statusActive: true, unexpired: false, active: false, expiresAt: expiredIso, origins: [] },
        });
      }
      return unexpected(q);
    });
    const repo = createOpeningConversationRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
    const listed = await repo.listTurns(scope, convId);
    expect(listed.map(t => ({ id: t.id, text: t.text, released: t.exposureReceipt?.releasedAt ?? null }))).toEqual([
      { id: tAlreadyReleased, text: "Already delivered", released: releasedIso },
      { id: tDirectUnreleased, text: unavailable, released: null },
      { id: tTransitiveUnreleased, text: unavailable, released: null },
      { id: tPrefixUnreleased, text: unavailable, released: null },
    ]);
    const summaries = await repo.listSummaries(scope);
    expect(summaries.map(s => s.lastTurnPreview)).toEqual([unavailable, unavailable, unavailable, "Already delivered"]);
    const resumed = await repo.releaseReturnedTurnIds(scope, convId, [
      tAlreadyReleased, tDirectUnreleased, tTransitiveUnreleased, tPrefixUnreleased,
    ]);
    expect(resumed).toEqual([
      { id: tAlreadyReleased, role: "assistant", text: "Already delivered", citations: [] },
      { id: tDirectUnreleased, role: "assistant", text: unavailable, citations: [] },
      { id: tTransitiveUnreleased, role: "assistant", text: unavailable, citations: [] },
      { id: tPrefixUnreleased, role: "assistant", text: unavailable, citations: [] },
    ]);
    expect(queries.some(q => q.text.startsWith("UPDATE opening_help_exposures"))).toBe(false);
  }

  // 4) Round-12 P2 #4: 64 jobless origins with distinct memory IDs + 64 hashless exchanges scale in O(N) (< 200 ms)
  // without quadratic binding map/array copying.
  {
    const n = 64;
    const joblessMems = Array.from({ length: n }, (_, i) => `c2100000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    const joblessTurns = Array.from({ length: n }, (_, i) => `c2200000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    const uIds = Array.from({ length: n }, (_, i) => `c2300000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    const aIds = Array.from({ length: n }, (_, i) => `c2400000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    const currentU = "c2500000-0000-4000-8000-000000000001";
    const convOrigins = joblessTurns.map((jid, i) => ({
      posUs: String(1_000 + i),
      posId: jid,
      origin: {
        id: jid, assistantTurnId: jid, courseId, consumerCourseId: null, materialUse: "citation" as const,
        refs: [{ memoryDependencyIds: [joblessMems[i]!] }], standalone: false, historical: true, jobBacked: false,
      },
    }));
    const exchangeRows = Array.from({ length: n }, (_, rev) => {
      const i = n - 1 - rev;
      return {
        conversation_id: convId, current_id: currentU, id: uIds[i]!, assistant_id: aIds[i]!,
        pos_us: String(2_000 + i), question: `Q${i}`, answer: `A${i}`,
        prior_course_id: courseId, assistant_course_id: courseId, current_course_id: courseId,
        material_use: "citation", prior_material_use: "citation", assistant_material_use: "citation",
        assistant_intent_hash: null, inherits_memory: true,
        user_source_refs: [], assistant_source_refs: [], user_direct_ids: [], assistant_direct_ids: [],
        memory_backing_ids: [], user_memory_backing_ids: [],
        assistant_direct_versioned: true, origin_allowed: true, current_allowed: true, conv_misconception_hashes: [],
      };
    });
    const { sql } = sqlSimulation(({ text, values }) => {
      if (text.startsWith("WITH prior AS MATERIALIZED")) return exchangeRows;
      if (text.startsWith("SELECT t.id, ARRAY(")) {
        return aIds.map((aid, i) => ({
          id: aid, origins: [], conversation_id: convId, consumer_course_id: courseId,
          pos_us: String(2_000 + i), pos_id: uIds[i]!, inherits_prefix: true,
          conv_origins: i === 0 ? convOrigins : null,
        }));
      }
      if (text.startsWith("SELECT dep_m.id, dep_m.course_id")) {
        if (values.includes("practice")) return [];
        return joblessMems.map(id => ({ id, course_id: courseId, source_turn_ids: [], expires_at: null }));
      }
      if (text.startsWith("SELECT m.id, course.id AS turn_course_id")) return [];
      if (text.startsWith("SELECT id FROM courses")) return [{ id: courseId }];
      if (text.startsWith("SELECT id FROM opening_memories")) {
        return joblessMems.map(memoryId => ({
          id: { memoryId, hashes: [], courseId, active: true, unexpired: true, origins: [] },
        }));
      }
      if (text.startsWith("WITH tick AS MATERIALIZED")) return values[0] as unknown[];
      return [];
    });
    const started = performance.now();
    const loaded = await loadTutorHistoryContext(sql, scope, currentU);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(200);
    expect(loaded.history).toHaveLength(40);
    expect(loaded.memoryIds).toEqual([...joblessMems].sort());
    expect(loaded.historyCourseBindings).toEqual([
      { courseId, materialUse: "citation", sourceIds: [], sourceRefs: [], memoryIds: [...joblessMems].sort() },
    ]);
  }
});

it("closes Round-13 receipt deadline enforcement, intermediate hashless course mismatch, legacy memoryOnly post-delivery visibility, and UUID-independent backing selection", async () => {
  const unavailable = "关联学习记录已更新或撤回，此回答内容不再显示。";
  const convId = "c3000000-0000-4000-8000-000000000001";
  const courseALineage = { kind: "v3_misconception_lineage" as const, courseId, revisionIds: [candidate.revisionId] };

  // 1) Round-13 P1 #1: releaseOpeningStudyExposure enforces expiresAt via savepoint rollback when expiring mid-release,
  // and listTurns / listSummaries / releaseReturnedTurnIds redact any turn whose receipt expires during sequential release.
  {
    const recId = "c3000000-0000-4000-8000-000000000011";
    const turn1 = "c3000000-0000-4000-8000-000000000012";
    const turn2 = "c3000000-0000-4000-8000-000000000013";
    const rec1 = "c3000000-0000-4000-8000-000000000014";
    const rec2 = "c3000000-0000-4000-8000-000000000015";
    const memTemp = "c3000000-0000-4000-8000-000000000016";
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    let courseRev = 5;
    let workspaceRev = 9;
    let rolledBack = false;
    let expireBeforeUpdate = true;

    const makeSavepointTx = () => {
      const sim = sqlSimulation(q => {
        const s = q.text;
        if (s.startsWith("SELECT *, (clock_timestamp() <")) {
          return [{
            id: recId, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: courseId,
            session_id: null, attempt_id: null, problem_id: null, release_key: "rk", exposure_origin: "assistant",
            support_domain: "unknown", context_anchor: { purpose: "learning_help", courseId },
            generated_at: new Date(at).toISOString(), released_at: null, acknowledged_at: null, history_revision: 0,
            before_deadline: true,
          }];
        }
        if (s.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
        if (s.startsWith("SELECT id FROM courses")) return [{ id: courseId }];
        if (s.startsWith("INSERT INTO opening_learning_history_revisions")) return [{ revision: ++courseRev }];
        if (s.startsWith("UPDATE opening_workspace_history_revisions")) return [{ revision: ++workspaceRev }];
        if (s.startsWith("UPDATE opening_help_exposures")) {
          expect(s).toContain("AND clock_timestamp() < ?::timestamptz");
          if (expireBeforeUpdate) return [];
          return [{
            id: recId, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: courseId,
            release_key: "rk", exposure_origin: "assistant", support_domain: "unknown",
            context_anchor: { purpose: "learning_help", courseId }, generated_at: new Date(at).toISOString(),
            released_at: new Date(at).toISOString(), acknowledged_at: null, history_revision: courseRev,
          }];
        }
        if (s.startsWith("SELECT DISTINCT COALESCE")) return [];
        if (s.startsWith("SELECT root_observation_id")) return [];
        return unexpected(q);
      });
      const tx = Object.assign(sim.sql, {
        savepoint: async <T>(fn: (sp: typeof sim.sql) => Promise<T>): Promise<T> => {
          const snapCourse = courseRev;
          const snapWs = workspaceRev;
          try {
            return await fn(sim.sql);
          } catch (err) {
            courseRev = snapCourse;
            workspaceRev = snapWs;
            rolledBack = true;
            throw err;
          }
        },
      });
      return { tx: tx as never, queries: sim.queries };
    };

    const sp1 = makeSavepointTx();
    expect(await releaseOpeningStudyExposure(sp1.tx, scope, recId, { expiresAt: futureIso })).toBeNull();
    expect(rolledBack).toBe(true);
    expect({ courseRev, workspaceRev }).toEqual({ courseRev: 5, workspaceRev: 9 });

    expireBeforeUpdate = false;
    rolledBack = false;
    const sp2 = makeSavepointTx();
    await expect(releaseOpeningStudyExposure(sp2.tx, scope, recId, { expiresAt: futureIso }))
      .resolves.toMatchObject({ id: recId, historyRevision: 6 });
    expect(rolledBack).toBe(false);
    expect({ courseRev, workspaceRev }).toEqual({ courseRev: 6, workspaceRev: 10 });

    // Sequential release across two receipts where rec1 succeeds and rec2 expires mid-batch:
    let rec2ExpiredMidBatch = false;
    const { sql } = sqlSimulation(q => {
      const s = q.text;
      if (s.startsWith("SELECT id, title, course_id")) return [{ id: convId, title: "t", course_id: courseId, updated_at: new Date(at).toISOString() }];
      if (s.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (s.startsWith("SELECT id FROM courses")) return [{ id: courseId }];
      if (s.includes("opening_workspace_history_revisions") || s.includes("opening_learning_history_revisions")) return [{ revision: 1 }];
      if (s.startsWith("SELECT c.id,")) {
        return [
          { id: convId, title: "c1", course_id: courseId, updated_at: new Date(at).toISOString(), misconception_memory_turn_id: turn1, pending_exposure_ids: [rec1], last_turn_preview: "Valid first" },
          { id: "c3000000-0000-4000-8000-000000000019", title: "c2", course_id: courseId, updated_at: new Date(at).toISOString(), misconception_memory_turn_id: turn2, pending_exposure_ids: [rec2], last_turn_preview: "Expired second" },
        ];
      }
      if (s.startsWith("SELECT t.id, t.conversation_id") || s.startsWith("SELECT t.id,t.role")) {
        return [
          { id: turn1, conversation_id: convId, role: "assistant", mode: "hint", status: "complete", created_at: new Date(at).toISOString(), text: "Valid first", citations: [], misconception_memory_turn_id: turn1, pending_exposure_ids: [rec1], exposure_receipt: { id: rec1, released_at: null } },
          { id: turn2, conversation_id: convId, role: "assistant", mode: "hint", status: "complete", created_at: new Date(at).toISOString(), text: "Expired second", citations: [], misconception_memory_turn_id: turn2, pending_exposure_ids: [rec2], exposure_receipt: { id: rec2, released_at: null } },
        ];
      }
      if (s.startsWith("SELECT t.id, ARRAY(")) {
        return [turn1, turn2].map(tid => ({
          id: tid, conversation_id: convId, consumer_course_id: courseId, pos_us: "100", pos_id: tid, inherits_prefix: false,
          origins: [{ id: tid, assistantTurnId: tid, courseId, consumerCourseId: courseId, materialUse: "citation", refs: [{ memoryDependencyIds: [memTemp] }], standalone: false }],
        }));
      }
      if (s.startsWith("SELECT id FROM opening_memories")) {
        return [{ id: { memoryId: memTemp, hashes: [], courseId, statusActive: true, unexpired: true, active: true, expiresAt: futureIso, origins: [] } }];
      }
      if (s.startsWith("SELECT *, (clock_timestamp() <")) {
        const targetRec = String(q.values[0]);
        return [{
          id: targetRec, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: courseId,
          release_key: `rk-${targetRec}`, exposure_origin: "assistant", support_domain: "unknown",
          context_anchor: { purpose: "learning_help", courseId }, generated_at: new Date(at).toISOString(),
          released_at: null, acknowledged_at: null, history_revision: 0,
          before_deadline: targetRec === rec1 ? true : !rec2ExpiredMidBatch,
        }];
      }
      if (s.startsWith("UPDATE opening_help_exposures")) {
        const targetRec = String(q.values[2]);
        if (targetRec === rec1) rec2ExpiredMidBatch = true;
        return [{
          id: targetRec, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: courseId,
          release_key: `rk-${targetRec}`, exposure_origin: "assistant", support_domain: "unknown",
          context_anchor: { purpose: "learning_help", courseId }, generated_at: new Date(at).toISOString(),
          released_at: new Date(at).toISOString(), acknowledged_at: null, history_revision: 2,
        }];
      }
      if (s.startsWith("SELECT DISTINCT COALESCE") || s.startsWith("SELECT root_observation_id")) return [];
      return unexpected(q);
    });
    const repo = createOpeningConversationRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
    rec2ExpiredMidBatch = false;
    const turnsOut = await repo.listTurns(scope, convId);
    expect(turnsOut.map(t => ({ id: t.id, text: t.text, hasReceipt: Boolean(t.exposureReceipt) }))).toEqual([
      { id: turn1, text: "Valid first", hasReceipt: true },
      { id: turn2, text: unavailable, hasReceipt: false },
    ]);
    rec2ExpiredMidBatch = false;
    const sumOut = await repo.listSummaries(scope);
    expect(sumOut.map(s => s.lastTurnPreview)).toEqual(["Valid first", unavailable]);
    rec2ExpiredMidBatch = false;
    const resumeOut = await repo.releaseReturnedTurnIds(scope, convId, [turn1, turn2]);
    expect(resumeOut).toEqual([
      { id: turn1, role: "assistant", text: "Valid first", citations: [] },
      { id: turn2, role: "assistant", text: unavailable, citations: [] },
    ]);
  }

  // 2) Round-13 P1 #2: Unbound conversation A/A (memory-bearing OR hashed misconception) -> hashless B (job-backed or jobless) -> hashless A
  // rejects/redacts the final Course-A answer while keeping ordinary (non-misconception) Course-A memory visible!
  {
    const memMiscA = "c3000000-0000-4000-8000-000000000021";
    const memOrdA = "c3000000-0000-4000-8000-000000000022";
    const u1 = "c3000000-0000-4000-8000-000000000023";
    const a1 = "c3000000-0000-4000-8000-000000000024";
    const bJobless = "c3000000-0000-4000-8000-000000000025";
    const u3 = "c3000000-0000-4000-8000-000000000026";
    const a3 = "c3000000-0000-4000-8000-000000000027";
    const rec3 = "c3000000-0000-4000-8000-000000000028";
    const currentA = "c3000000-0000-4000-8000-000000000029";
    let withMisconception = true;
    const { sql, queries } = sqlSimulation(q => {
      const s = q.text;
      const activeMem = withMisconception ? memMiscA : memOrdA;
      if (s.startsWith("SELECT id, title, course_id")) return [{ id: convId, title: "t", course_id: null, updated_at: new Date(at).toISOString() }];
      if (s.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (s.startsWith("SELECT id FROM courses")) return [{ id: courseId }, { id: otherCourseId }];
      if (s.includes("opening_workspace_history_revisions") || s.includes("opening_learning_history_revisions")) return [{ revision: 1 }];
      if (s.startsWith("SELECT t.id, t.conversation_id") || s.startsWith("SELECT t.id,t.role")) {
        return [{
          id: a3, conversation_id: convId, role: "assistant", mode: "hint", status: "complete",
          created_at: new Date(at).toISOString(), text: "Final hashless A", citations: [],
          misconception_memory_turn_id: a3, pending_exposure_ids: [rec3], exposure_receipt: { id: rec3, released_at: null },
        }];
      }
      if (s.startsWith("SELECT c.id,")) {
        return [{
          id: convId, title: "t", course_id: null, updated_at: new Date(at).toISOString(),
          misconception_memory_turn_id: a3, pending_exposure_ids: [rec3], last_turn_preview: "Final hashless A",
        }];
      }
      if (s.startsWith("SELECT t.id, ARRAY(")) {
        return [
          {
            id: a3, origins: [], conversation_id: convId, consumer_course_id: courseId,
            pos_us: "300", pos_id: u3, inherits_prefix: true,
            conv_origins: [{
              posUs: "100", posId: u1,
              origin: {
                id: a1, assistantTurnId: a1, courseId, consumerCourseId: null, materialUse: "citation",
                refs: [{ memoryDependencyIds: [activeMem] }], standalone: false, historical: true, jobBacked: true,
              },
            }],
            conv_consumers: [
              { posUs: "100", posId: u1, assistantTurnId: a1, courseId },
              { posUs: "200", posId: bJobless, assistantTurnId: bJobless, courseId: otherCourseId },
              { posUs: "300", posId: u3, assistantTurnId: a3, courseId },
            ],
          },
          {
            id: a1,
            origins: [{
              id: a1, assistantTurnId: a1, courseId, consumerCourseId: courseId, materialUse: "citation",
              refs: [{ memoryDependencyIds: [activeMem] }], standalone: false, historical: false, jobBacked: true,
            }],
            conversation_id: convId, consumer_course_id: courseId,
            pos_us: "100", pos_id: u1, inherits_prefix: true,
            conv_origins: null, conv_consumers: null,
          },
        ];
      }
      if (s.startsWith("WITH prior AS MATERIALIZED")) {
        const base = {
          conversation_id: convId, current_id: currentA, current_pos_us: "400", current_course_id: courseId,
          material_use: "citation", prior_material_use: "citation", assistant_material_use: "citation",
          assistant_intent_hash: null, user_source_refs: [], user_direct_ids: [], assistant_direct_ids: [],
          memory_backing_ids: [], user_memory_backing_ids: [],
          assistant_direct_versioned: true, origin_allowed: true, current_allowed: true, conv_misconception_hashes: [],
        };
        return [
          { ...base, id: u3, assistant_id: a3, pos_us: "300", prior_course_id: courseId, assistant_course_id: courseId, inherits_memory: true, assistant_source_refs: [], question: "Q3", answer: "Final hashless A" },
          { ...base, id: u1, assistant_id: a1, pos_us: "100", prior_course_id: courseId, assistant_course_id: courseId, inherits_memory: true, assistant_source_refs: [{ memoryDependencyIds: [activeMem] }], question: "Q1", answer: "Initial A" },
        ];
      }
      if (s.startsWith("SELECT dep_m.id, dep_m.course_id")) {
        return [{ id: activeMem, course_id: courseId, source_turn_ids: [], expires_at: null }];
      }
      if (s.startsWith("SELECT m.id, course.id AS turn_course_id")) return [];
      if (s.startsWith("SELECT id FROM opening_memories")) {
        return [{
          id: {
            memoryId: activeMem,
            hashes: withMisconception ? [JSON.stringify(courseALineage)] : [],
            courseId, active: true, unexpired: true, statusActive: true, notCandidate: true, origins: [],
          },
        }];
      }
      if (s.startsWith("WITH tick AS MATERIALIZED")) return [{ position: 0 }];
      if (s.startsWith("SELECT * FROM opening_help_exposures")) {
        return [{
          id: rec3, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: courseId,
          release_key: "rk3", exposure_origin: "assistant", support_domain: "unknown",
          context_anchor: { purpose: "learning_help", courseId }, generated_at: new Date(at).toISOString(),
          released_at: null, acknowledged_at: null, history_revision: 0,
        }];
      }
      if (s.startsWith("UPDATE opening_help_exposures")) {
        return [{
          id: rec3, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: courseId,
          release_key: "rk3", exposure_origin: "assistant", support_domain: "unknown",
          context_anchor: { purpose: "learning_help", courseId }, generated_at: new Date(at).toISOString(),
          released_at: new Date(at).toISOString(), acknowledged_at: null, history_revision: 1,
        }];
      }
      if (s.startsWith("SELECT DISTINCT COALESCE") || s.startsWith("SELECT root_observation_id")
        || s.startsWith("SELECT source_id FROM opening_privacy_exclusions")
        || s.startsWith("SELECT id, left(text, 12001)")) return [];
      return unexpected(q);
    });
    const repo = createOpeningConversationRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
    expect(await repo.listTurns(scope, convId)).toMatchObject([{ id: a3, text: unavailable }]);
    expect(await repo.listSummaries(scope)).toMatchObject([{ id: convId, lastTurnPreview: unavailable }]);
    expect(await repo.releaseReturnedTurnIds(scope, convId, [a3])).toEqual([{ id: a3, role: "assistant", text: unavailable, citations: [] }]);
    expect(queries.some(q => q.text.startsWith("UPDATE opening_help_exposures"))).toBe(false);
    expect((await loadTutorHistoryContext(sql, scope, currentA)).history).toEqual([
      { role: "user", text: "Q1" },
      { role: "assistant", text: "Initial A" },
    ]);
    expect((await readTutorHistoryAncestorStatus(sql, scope, currentA)).valid).toBe(false);

    // Ordinary Course-A memory (no misconception) in Turn 1 stays valid across intermediate hashless Course-B Turn 2!
    withMisconception = false;
    expect(await repo.listTurns(scope, convId)).toMatchObject([{ id: a3, text: "Final hashless A" }]);
    expect((await loadTutorHistoryContext(sql, scope, currentA)).history).toEqual([
      { role: "user", text: "Q1" },
      { role: "assistant", text: "Initial A" },
      { role: "user", text: "Q3" },
      { role: "assistant", text: "Final hashless A" },
    ]);
  }

  // 3) Round-13 P2 #3 & P2 #4:
  // (a) Standalone legacy memoryOnly answer with expired sole temporary backing remains visible if already released, and redacts if unreleased;
  // (b) Derived memory ("5555...") with lower-UUID expired backing ("0000...") and higher-UUID unexpired backing ("ffff...") both carrying
  //     active misconception lineage selects the unexpired backing regardless of UUID order!
  {
    const srcId = "c3000000-0000-4000-8000-000000000030";
    const tempBackExpired = "c3000000-0000-4000-8000-000000000031";
    const lowExpiredBacking = "00000000-0000-4000-8000-000000000001";
    const midDerivedMem = "55555555-5555-4555-8555-555555555555";
    const highValidBacking = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const tLegacyDelivered = "c3000000-0000-4000-8000-000000000032";
    const tLegacyUnreleased = "c3000000-0000-4000-8000-000000000033";
    const tDerivedFirstDelivery = "c3000000-0000-4000-8000-000000000034";
    const rDelivered = "c3000000-0000-4000-8000-000000000035";
    const rLegacyUnreleased = "c3000000-0000-4000-8000-000000000036";
    const rDerivedPending = "c3000000-0000-4000-8000-000000000037";
    const legacyOriginTurn = "c3000000-0000-4000-8000-000000000038";
    const releasedIso = new Date(at).toISOString();
    const expiredIso = new Date(Date.now() - 10_000).toISOString();
    const releasedReceipts: string[] = [];
    const { sql } = sqlSimulation(q => {
      const s = q.text;
      if (s.startsWith("SELECT id, title, course_id")) return [{ id: convId, title: "t", course_id: null, updated_at: releasedIso }];
      if (s.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (s.includes("opening_workspace_history_revisions") || s.includes("opening_learning_history_revisions")) return [{ revision: 1 }];
      if (s.startsWith("SELECT t.id, t.conversation_id") || s.startsWith("SELECT t.id,t.role")) {
        return [
          {
            id: tLegacyDelivered, conversation_id: convId, role: "assistant", mode: "hint", status: "complete",
            created_at: releasedIso, text: "Delivered legacy temp", citations: [], misconception_memory_turn_id: tLegacyDelivered,
            pending_exposure_ids: [],
            exposure_receipt: { id: rDelivered, release_key: "rd", context_anchor: { purpose: "learning_help" }, exposure_origin: "assistant", support_domain: "unknown", generated_at: releasedIso, released_at: releasedIso, acknowledged_at: null, history_revision: 1 },
          },
          {
            id: tLegacyUnreleased, conversation_id: convId, role: "assistant", mode: "hint", status: "complete",
            created_at: releasedIso, text: "Unreleased legacy temp", citations: [], misconception_memory_turn_id: tLegacyUnreleased,
            pending_exposure_ids: [rLegacyUnreleased], exposure_receipt: { id: rLegacyUnreleased, released_at: null },
          },
          {
            id: tDerivedFirstDelivery, conversation_id: convId, role: "assistant", mode: "hint", status: "complete",
            created_at: releasedIso, text: "Valid derived despite low expired UUID", citations: [], misconception_memory_turn_id: tDerivedFirstDelivery,
            pending_exposure_ids: [rDerivedPending], exposure_receipt: { id: rDerivedPending, released_at: null },
          },
        ];
      }
      if (s.startsWith("SELECT t.id, ARRAY(")) {
        return [
          { id: tLegacyDelivered, origins: [{ id: tLegacyDelivered, assistantTurnId: tLegacyDelivered, courseId: null, consumerCourseId: null, materialUse: "citation", refs: [{ sourceId: srcId, sourceVersion: 1, memoryOnly: true }], standalone: true }], inherits_prefix: false },
          { id: tLegacyUnreleased, origins: [{ id: tLegacyUnreleased, assistantTurnId: tLegacyUnreleased, courseId: null, consumerCourseId: null, materialUse: "citation", refs: [{ sourceId: srcId, sourceVersion: 1, memoryOnly: true }], standalone: true }], inherits_prefix: false },
          { id: tDerivedFirstDelivery, origins: [{ id: tDerivedFirstDelivery, assistantTurnId: tDerivedFirstDelivery, courseId: null, consumerCourseId: null, materialUse: "citation", refs: [{ memoryDependencyIds: [midDerivedMem] }], standalone: true }], inherits_prefix: false },
        ];
      }
      if (s.startsWith("SELECT saved.id,")) {
        expect(s).toContain("m.kind = 'temporary' AND m.expires_at IS NOT NULL");
        expect(s).not.toContain("m.expires_at > clock_timestamp()");
        const parsed = q.values.find(Array.isArray) as Array<{ id: string }>;
        return parsed.map(item => ({
          id: item.id,
          backings: item.id === legacyOriginTurn ? [[lowExpiredBacking, highValidBacking]] : [[tempBackExpired]],
        }));
      }
      if (s.startsWith("SELECT id FROM opening_memories")) {
        const requested = (q.values[1] as string[]) ?? [];
        return requested.map(id => {
          if (id === midDerivedMem) {
            return {
              id: {
                memoryId: midDerivedMem, hashes: [], courseId: null, statusActive: true, notCandidate: true, unexpired: true, active: true, expiresAt: null,
                origins: [{ id: legacyOriginTurn, assistantTurnId: legacyOriginTurn, courseId: null, consumerCourseId: null, materialUse: "citation", refs: [{ sourceId: srcId, sourceVersion: 1, memoryOnly: true }], standalone: true }],
              },
            };
          }
          if (id === lowExpiredBacking) {
            return {
              id: {
                memoryId: lowExpiredBacking, hashes: [JSON.stringify(usedLineage)], courseId: null, statusActive: true, notCandidate: true, unexpired: true, active: true, expiresAt: null,
                origins: [{ id: "c3000000-0000-4000-8000-000000000039", assistantTurnId: "c3000000-0000-4000-8000-000000000039", courseId: null, consumerCourseId: null, materialUse: "citation", refs: [{ memoryDependencyIds: [tempBackExpired] }], standalone: true }],
              },
            };
          }
          if (id === highValidBacking) {
            return { id: { memoryId: highValidBacking, hashes: [JSON.stringify(usedLineage)], courseId: null, statusActive: true, notCandidate: true, unexpired: true, active: true, expiresAt: null, origins: [] } };
          }
          return { id: { memoryId: tempBackExpired, hashes: [JSON.stringify(usedLineage)], courseId: null, statusActive: true, notCandidate: true, unexpired: false, active: false, expiresAt: expiredIso, origins: [] } };
        });
      }
      if (s.startsWith("WITH tick AS MATERIALIZED")) return [{ position: 0 }];
      if (s.startsWith("SELECT * FROM opening_help_exposures")) {
        const targetRec = String(q.values[0]);
        return [{
          id: targetRec, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: null,
          release_key: `rk-${targetRec}`, exposure_origin: "assistant", support_domain: "unknown",
          context_anchor: { purpose: "learning_help" }, generated_at: releasedIso,
          released_at: null, acknowledged_at: null, history_revision: 0,
        }];
      }
      if (s.startsWith("UPDATE opening_help_exposures")) {
        const targetRec = String(q.values[2]);
        releasedReceipts.push(targetRec);
        return [{
          id: targetRec, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: null,
          release_key: `rk-${targetRec}`, exposure_origin: "assistant", support_domain: "unknown",
          context_anchor: { purpose: "learning_help" }, generated_at: releasedIso,
          released_at: releasedIso, acknowledged_at: null, history_revision: 2,
        }];
      }
      if (s.startsWith("SELECT DISTINCT COALESCE") || s.startsWith("SELECT root_observation_id")) return [];
      return unexpected(q);
    });
    const repo = createOpeningConversationRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));
    const listed = await repo.listTurns(scope, convId);
    expect(listed.map(t => ({ id: t.id, text: t.text, released: t.exposureReceipt?.releasedAt ?? null }))).toEqual([
      { id: tLegacyDelivered, text: "Delivered legacy temp", released: releasedIso },
      { id: tLegacyUnreleased, text: unavailable, released: null },
      { id: tDerivedFirstDelivery, text: "Valid derived despite low expired UUID", released: releasedIso },
    ]);
    expect(releasedReceipts).toEqual([rDerivedPending]);
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
      CREATE TABLE opening_help_exposures (id uuid PRIMARY KEY, workspace_id uuid, owner_user_id uuid, course_id uuid,
        session_id uuid, attempt_id uuid, problem_id uuid, item_version_id uuid, activity_id uuid, turn_id uuid,
        exposure_origin text, support_domain text DEFAULT 'unknown', hint_stage int, initiated_by text,
        help_input_snapshot jsonb, release_key text, release_intent jsonb,
        context_anchor jsonb DEFAULT '{"purpose":"learning_help"}', delivered bool DEFAULT false,
        generated_at timestamptz DEFAULT now(), released_at timestamptz, delivered_at timestamptz,
        acknowledged_at timestamptz, history_revision bigint DEFAULT 0, workspace_history_revision bigint DEFAULT 0);
      CREATE TABLE opening_learning_history_revisions (workspace_id uuid, owner_user_id uuid, course_id uuid,
        revision bigint DEFAULT 0, PRIMARY KEY (workspace_id, owner_user_id, course_id));
      CREATE TABLE opening_learning_observations (id uuid PRIMARY KEY, root_observation_id uuid, workspace_id uuid,
        owner_user_id uuid, course_id uuid, attempt_id uuid, problem_id uuid, session_id uuid,
        source_ids uuid[] DEFAULT '{}', skill_label text);
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
      CREATE INDEX ON opening_turns (workspace_id, conversation_id);
      CREATE INDEX ON opening_memories (workspace_id);
    `);
    await db.query("INSERT INTO workspaces VALUES ($1,$2,7)", [scope.workspaceId, scope.ownerUserId]);
    await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,NULL)", [jobId, scope.workspaceId, scope.ownerUserId]);
    await db.query("INSERT INTO v3_bitemporal_misconception_edges VALUES ($1,$2,$3,NULL,7,'(,)','(,)','candidate')",
      [candidate.revisionId, scope.workspaceId, scope.ownerUserId]);
    const plans: { query: string; cost: number }[] = [];
    let explain = false;
    let spSeq = 0;
    let useRealTx = false;
    let txDepth = 0;
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
        if (explain && txDepth === 0 && /^(SELECT|WITH)\b/.test(query)) {
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
      {
        unsafe: (text: string) => new SqlFragment([text]),
        json: JSON.stringify,
        begin: async (run: (tx: Sql) => Promise<unknown>) => {
          if (!useRealTx) return run(sql);
          if (txDepth === 0) {
            txDepth++;
            await db.exec("BEGIN");
            try {
              const out = await run(sql);
              await db.exec("COMMIT");
              return out;
            } catch (error) {
              await db.exec("ROLLBACK");
              throw error;
            } finally {
              txDepth--;
            }
          }
          return (sql as unknown as { savepoint: <T>(fn: (sp: Sql) => Promise<T>) => Promise<T> }).savepoint(run);
        },
        savepoint: async <T>(run: (sp: Sql) => Promise<T>): Promise<T> => {
          if (!useRealTx || txDepth === 0) return run(sql);
          const sp = `r13_sp_${++spSeq}`;
          await db.exec(`SAVEPOINT ${sp}`);
          try {
            const out = await run(sql);
            await db.exec(`RELEASE SAVEPOINT ${sp}`);
            return out;
          } catch (error) {
            await db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
            await db.exec(`RELEASE SAVEPOINT ${sp}`);
            throw error;
          }
        },
      },
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

    // Round-9 Step-1 P2: 64 restored hashless assistant answers avoid quadratic prefix rescans across
    // listTurns / readContinuityRows (conv_lineage Actual Loops = 1) and readTurnMisconceptionMemoryOrigins.
    const bulkConv = "ae000000-0000-4000-8000-000000000000";
    const bulkTurnIds = Array.from({ length: 64 }, (_, idx) =>
      `ae000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`);
    await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,$4)",
      [bulkConv, scope.workspaceId, scope.ownerUserId, courseId]);
    const baseEpochSec = 1_760_000_000;
    for (const [idx, id] of bulkTurnIds.entries()) {
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,
          context_source_refs,context_anchor,query_system,created_at,text)
        VALUES ($1,$2,$3,'assistant','complete',NULL,'[]',$4,false,to_timestamp($5),$6)`,
        [id, scope.workspaceId, bulkConv, JSON.stringify({ courseId }), baseEpochSec + idx, `Restored answer #${idx + 1}`]);
    }
    await db.exec("ANALYZE");
    type ExplainPlanNode = {
      "Node Type": string;
      Alias?: string;
      "Subplan Name"?: string;
      "CTE Name"?: string;
      "Total Cost": number;
      "Actual Loops"?: number;
      "Actual Rows"?: number;
      "Relation Name"?: string;
      Filter?: string;
      "Join Filter"?: string;
      "Hash Cond"?: string;
      Plans?: ExplainPlanNode[];
    };
    const collectNodes = (node: ExplainPlanNode): ExplainPlanNode[] => [
      node,
      ...(node.Plans ?? []).flatMap(collectNodes),
    ];
    let analyzeNextDisplayQueries = false;
    const analyzedDisplayPlans: Array<{ query: string; root: ExplainPlanNode }> = [];
    const origExecute = SqlFragment.prototype.execute;
    SqlFragment.prototype.execute = async function (this: SqlFragment) {
      if (analyzeNextDisplayQueries) {
        const params: unknown[] = [];
        const rendered = this.render(params).trim();
        if (rendered.startsWith("SELECT t.id, t.conversation_id") || rendered.startsWith("SELECT t.id,t.role")) {
          const analyzed = await db.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
            "EXPLAIN (ANALYZE, FORMAT JSON) " + rendered, params);
          analyzedDisplayPlans.push({ query: rendered, root: analyzed.rows[0]!["QUERY PLAN"][0]!.Plan });
        }
      }
      return origExecute.call(this);
    };
    try {
      analyzeNextDisplayQueries = true;
      const cleanTurns = await repo.listTurns(scope, bulkConv);
      const cleanContinuity = await repo.loadContinuityTurns(scope, bulkConv);
      analyzeNextDisplayQueries = false;
      expect(cleanTurns.map(t => t.text)).toEqual(bulkTurnIds.map((_, idx) => `Restored answer #${idx + 1}`));
      expect(cleanContinuity.map(t => t.text)).toEqual(bulkTurnIds.map((_, idx) => `Restored answer #${idx + 1}`));
      expect(analyzedDisplayPlans).toHaveLength(2);
      for (const { query: rendered, root } of analyzedDisplayPlans) {
        expect(root["Total Cost"], rendered.slice(0, 80)).toBeLessThan(20_000);
        const allNodes = collectNodes(root);
        const convScanCte = allNodes.find(n => n["Subplan Name"] === "CTE conv_scan");
        expect(convScanCte, "expected materialized CTE conv_scan in conv_lineage").toBeDefined();
        expect(convScanCte!["Actual Loops"]).toBe(1);
        expect(convScanCte!["Actual Rows"]).toBe(0);
        const dtScan = allNodes.find(n => n["Relation Name"] === "opening_turns" && n.Alias === "dt");
        expect(dtScan, "expected single-pass dt scan").toBeDefined();
        expect(dtScan!["Actual Loops"]).toBe(1);
        expect(dtScan!["Actual Rows"]).toBe(64);
        const tScan = allNodes.find(n => n["Relation Name"] === "opening_turns" && n.Alias === "t");
        expect(tScan, "expected outer t scan").toBeDefined();
        expect(tScan!["Actual Loops"]).toBe(1);
        expect(tScan!["Actual Rows"]).toBe(64);
        for (const scan of allNodes.filter(n => n["Relation Name"] === "opening_turns")) {
          expect((scan["Actual Loops"] ?? 0) * (scan["Actual Rows"] ?? 0)).toBeLessThanOrEqual(64);
        }
      }

      // 1) Early withdrawn hashed answer at index 9 (10th turn) redacts turn #10 and subsequent hashless #11..#64,
      // while keeping earlier hashless answers #1..#9 intact.
      const earlyIdx = 9;
      const earlyTurnId = bulkTurnIds[earlyIdx]!;
      await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=$1,status='retracted'", [courseId]);
      await db.query("UPDATE opening_turns SET intent_hash=$1 WHERE id=$2", [JSON.stringify(exact), earlyTurnId]);
      const afterWithdrawnHashed = await repo.listTurns(scope, bulkConv);
      expect(afterWithdrawnHashed.slice(0, earlyIdx).map(t => t.text))
        .toEqual(Array.from({ length: earlyIdx }, (_, idx) => `Restored answer #${idx + 1}`));
      expect(afterWithdrawnHashed.slice(earlyIdx).every(t => t.text === unavailable)).toBe(true);
      const continuityAfterHashed = await repo.loadContinuityTurns(scope, bulkConv);
      expect(continuityAfterHashed.slice(0, earlyIdx).map(t => t.text))
        .toEqual(Array.from({ length: earlyIdx }, (_, idx) => `Restored answer #${idx + 1}`));
      expect(continuityAfterHashed.slice(earlyIdx).every(t => t.text === unavailable)).toBe(true);

      // 2) All 64 restored hashless answers reference a memory (plus early legacy memoryOnly ref at index 9):
      // active before withdrawal, then redacts #10..#64 (pos >= early_pos) while keeping #1..#9 intact,
      // with single-pass SQL (Actual Loops = 1) and O(N) Node evaluation (zero N(N-1)/2 expansion).
      const bulkActiveMemory = "ae000000-0000-4000-8000-000000000998";
      const bulkLegacyMemory = "ae000000-0000-4000-8000-000000000999";
      const cleanOriginId = "ae000000-0000-4000-8000-000000000997";
      await db.query("UPDATE opening_conversations SET course_id=NULL WHERE id=ANY($1::uuid[])", [[originConversation, bulkConv]]);
      await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=NULL,status='candidate'");
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,query_system,created_at,text)
        VALUES ($1,$2,$3,'assistant','complete',$4,'[]',false,to_timestamp(1759999000),'Clean memory origin')`,
        [cleanOriginId, scope.workspaceId, originConversation, JSON.stringify(cleanLineage)]);
      await db.query("UPDATE opening_turns SET intent_hash=$1,context_source_refs=$2,source_ids=ARRAY[$3]::uuid[] WHERE id=$4",
        [JSON.stringify(usedLineage), JSON.stringify([{ sourceId, sourceVersion: 1 }]), sourceId, originId]);
      await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,NULL,$3,'confirmed',NULL), ($4,$2,NULL,$5,'confirmed',NULL)",
        [bulkActiveMemory, scope.workspaceId, JSON.stringify([cleanOriginId]), bulkLegacyMemory, JSON.stringify([originId])]);
      await db.query("UPDATE opening_turns SET intent_hash=NULL,context_anchor=NULL,context_source_refs=$1 WHERE conversation_id=$2",
        [JSON.stringify([{ memoryDependencyIds: [bulkActiveMemory] }]), bulkConv]);
      await db.query("UPDATE opening_turns SET context_source_refs=$1 WHERE id=$2",
        [JSON.stringify([{ sourceId, sourceVersion: 1, memoryOnly: true }]), earlyTurnId]);
      await db.exec("ANALYZE");
      let backingResolveQueries = 0;
      let originBatchQueries = 0;
      let memoryLineageQueries = 0;
      SqlFragment.prototype.execute = async function (this: SqlFragment) {
        const params: unknown[] = [];
        const rendered = this.render(params).trim();
        if (rendered.startsWith("SELECT t.id, ARRAY(")) {
          originBatchQueries += 1;
          const analyzed = await db.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
            "EXPLAIN (ANALYZE, FORMAT JSON) " + rendered, params);
          const planRoot = analyzed.rows[0]!["QUERY PLAN"][0]!.Plan;
          expect(planRoot["Total Cost"]).toBeLessThan(20_000);
          const priorAScan = collectNodes(planRoot)
            .find(n => n["Relation Name"] === "opening_turns" && n.Alias === "prior_a");
          expect(priorAScan, "expected single-pass prior_a scan").toBeDefined();
          expect(priorAScan!["Actual Loops"]).toBe(1);
        }
        if (rendered.startsWith("SELECT saved.id,")) backingResolveQueries += 1;
        if (rendered.startsWith("SELECT id FROM opening_memories AS m(memory_id)")) memoryLineageQueries += 1;
        return origExecute.call(this);
      };
      const allActiveMemoryTurns = await repo.listTurns(scope, bulkConv);
      expect(allActiveMemoryTurns.map(t => t.text)).toEqual(bulkTurnIds.map((_, idx) => `Restored answer #${idx + 1}`));
      expect(originBatchQueries).toBe(1);
      expect(backingResolveQueries).toBe(1);
      expect(memoryLineageQueries).toBe(1);
      await expect(repo.releaseReturnedTurnIds(scope, bulkConv, bulkTurnIds)).resolves.toHaveLength(64);
      expect(originBatchQueries).toBe(2);
      expect(backingResolveQueries).toBe(2);

      await db.query("UPDATE v3_bitemporal_misconception_edges SET status='retracted'");
      const afterWithdrawnMemory = await repo.listTurns(scope, bulkConv);
      expect(afterWithdrawnMemory.slice(0, earlyIdx).map(t => t.text))
        .toEqual(Array.from({ length: earlyIdx }, (_, idx) => `Restored answer #${idx + 1}`));
      expect(afterWithdrawnMemory.slice(earlyIdx).every(t => t.text === unavailable)).toBe(true);
      expect(originBatchQueries).toBe(3);
      expect(backingResolveQueries).toBe(3);
      const invalidSet = await readTurnsWithInvalidMisconceptionMemories(sql, scope, bulkTurnIds, { display: true });
      expect([...invalidSet].sort()).toEqual(bulkTurnIds.slice(earlyIdx).sort());
      expect(originBatchQueries).toBe(4);

      const batchedMap = await readTurnMisconceptionMemoryOrigins(sql, scope, bulkTurnIds.slice(earlyIdx, earlyIdx + 3));
      expect(batchedMap.size).toBe(3);
      expect(batchedMap.get(earlyTurnId)?.[0]).toMatchObject({
        id: earlyTurnId,
        historical: false,
        ids: [],
        backings: [[memoryId, bulkLegacyMemory]],
      });
      expect(batchedMap.get(bulkTurnIds[earlyIdx + 1]!)?.some(o => o?.id === earlyTurnId && o.historical === true)).toBe(true);

      // 3) Round-10 P2 #3 + Round-11 P2 #4/#5/#6/#7:
      // 32 jobless memory-bearing origins + 32 job-backed hashed exchanges (each introducing a distinct active revision
      // plus a shared revision) + 32 job-backed hashless exchanges (each carrying a distinct temporary memory deadline):
      // single-pass conv_scan (Actual Loops = 1), < 20,000 plan cost, O(K) revision/deadline/sweep handling, and zero `= ANY`
      // array scan on invalid_assistant_ids before and after withdrawing the shared revision across all 32 hashed answers.
      const histPerfConv = "af000000-0000-4000-8000-000000000001";
      const histPerfCurrent = "af000000-0000-4000-8000-000000000002";
      const sharedPerfRev = "af000010-0000-4000-8000-000000000099";
      const joblessPerfMem = "af000020-0000-4000-8000-000000000099";
      const distinctPerfRevs = Array.from({ length: 32 }, (_, idx) =>
        `af000010-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`);
      const distinctPerfMems = Array.from({ length: 32 }, (_, idx) =>
        `af000020-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`);
      const perfBaseExpiryMs = Date.now() + 300_000;
      const earliestPerfIso = new Date(perfBaseExpiryMs).toISOString();
      await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,$4)",
        [histPerfConv, scope.workspaceId, scope.ownerUserId, courseId]);
      for (const revId of [...distinctPerfRevs, sharedPerfRev]) {
        await db.query("INSERT INTO v3_bitemporal_misconception_edges VALUES ($1,$2,$3,$4,7,'(,)','(,)','candidate')",
          [revId, scope.workspaceId, scope.ownerUserId, courseId]);
      }
      await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,$3,$4,'confirmed',NULL)",
        [joblessPerfMem, scope.workspaceId, courseId, JSON.stringify([cleanOriginId])]);
      for (let k = 0; k < 32; k++) {
        const expIso = new Date(perfBaseExpiryMs + k * 1_000).toISOString();
        await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,$3,$4,'temporary',$5)",
          [distinctPerfMems[k]!, scope.workspaceId, courseId, JSON.stringify([cleanOriginId]), expIso]);
        const joblessId = `af000004-0000-4000-8000-${String(k + 1).padStart(12, "0")}`;
        await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,
            context_source_refs,context_anchor,query_system,created_at,text)
          VALUES ($1,$2,$3,'assistant','complete',NULL,$4,$5,false,to_timestamp($6),$7)`,
          [joblessId, scope.workspaceId, histPerfConv, JSON.stringify([{ memoryDependencyIds: [joblessPerfMem] }]),
            JSON.stringify({ courseId }), baseEpochSec + 9_000 + k, `Jobless#${k + 1}`]);
      }
      for (let idx = 0; idx < 64; idx++) {
        const uId = `af000001-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`;
        const aId = `af000002-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`;
        const jId = `af000003-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`;
        const hash = idx < 32
          ? JSON.stringify({ kind: "v3_misconception_lineage", courseId, revisionIds: [distinctPerfRevs[idx]!, sharedPerfRev] })
          : null;
        const aRefs = idx < 32 ? "[]" : JSON.stringify([{ memoryDependencyIds: [distinctPerfMems[idx - 32]!] }]);
        await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,
            context_source_refs,context_anchor,query_system,created_at,text)
          VALUES ($1,$3,$4,'user','complete',NULL,'[]',$6,false,to_timestamp($7),$8),
                 ($2,$3,$4,'assistant','complete',$5,$10,$6,false,to_timestamp($7),$9)`,
          [uId, aId, scope.workspaceId, histPerfConv, hash, JSON.stringify({ courseId }),
            baseEpochSec + 10_000 + idx * 2, `Q${idx + 1}`, `A${idx + 1}`, aRefs]);
        await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$5)",
          [jId, scope.workspaceId, histPerfConv, uId, aId]);
      }
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$2,$3,'user','complete','[]',$4,false,to_timestamp($5),'Q65')`,
        [histPerfCurrent, scope.workspaceId, histPerfConv, JSON.stringify({ courseId }), baseEpochSec + 10_200]);
      await db.exec("ANALYZE");
      const historyExplainPlans: ExplainPlanNode[] = [];
      const activeLineageBatchSizes: number[] = [];
      SqlFragment.prototype.execute = async function (this: SqlFragment) {
        const params: unknown[] = [];
        const rendered = this.render(params).trim();
        if (rendered.startsWith("WITH prior AS MATERIALIZED")) {
          expect(rendered).not.toContain("invalid_assistant_ids");
          expect(rendered).not.toContain("prior.assistant_id = ANY");
          const analyzed = await db.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
            "EXPLAIN (ANALYZE, FORMAT JSON) " + rendered, params);
          historyExplainPlans.push(analyzed.rows[0]!["QUERY PLAN"][0]!.Plan);
        }
        if (rendered.startsWith("WITH tick AS MATERIALIZED") && typeof params[0] === "string") {
          activeLineageBatchSizes.push((JSON.parse(params[0]) as unknown[]).length);
        }
        if (rendered.startsWith("SELECT id FROM opening_memories AS m(memory_id)")) {
          const analyzed = await db.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
            "EXPLAIN (ANALYZE, FORMAT JSON) " + rendered, params);
          const batchIds = Array.isArray(params[1]) ? params[1].length : 1;
          expect(analyzed.rows[0]!["QUERY PLAN"][0]!.Plan["Total Cost"] / Math.max(1, batchIds)).toBeLessThan(20_000);
          return (await db.query(rendered, params)).rows;
        }
        return origExecute.call(this);
      };
      const perfHistory = await loadTutorHistoryContext(sql, scope, histPerfCurrent);
      expect(perfHistory.history).toHaveLength(40);
      expect(perfHistory.historyMisconceptionLineage).toEqual({
        kind: "v3_misconception_lineage",
        courseId,
        revisionIds: [distinctPerfRevs[0]!, sharedPerfRev, ...distinctPerfRevs.slice(1)],
      });
      expect(perfHistory.memoryIds).toEqual([joblessPerfMem, ...distinctPerfMems].sort());
      expect(perfHistory.temporaryMemoryExpiresAt).toBe(earliestPerfIso);
      const perfAncestorStatus = await readTutorHistoryAncestorStatus(sql, scope, histPerfCurrent);
      expect(perfAncestorStatus).toMatchObject({
        valid: true,
        hasAncestors: true,
        earliestExpiresAtMs: Date.parse(earliestPerfIso),
      });
      expect(historyExplainPlans).toHaveLength(2);
      for (const plan of historyExplainPlans) {
        expect(plan["Total Cost"]).toBeLessThan(20_000);
        const nodes = collectNodes(plan);
        const histConvScan = nodes.find(n => n["Subplan Name"] === "CTE conv_scan");
        expect(histConvScan, "expected single-pass CTE conv_scan in readSavedExchanges").toBeDefined();
        expect(histConvScan!["Actual Loops"]).toBe(1);
        expect(nodes.some(n => (n.Filter ?? "").includes("assistant_id = ANY") || (n["Join Filter"] ?? "").includes("ANY"))).toBe(false);
      }
      expect(activeLineageBatchSizes).toEqual([32, 32]);

      // Withdrawing 1 shared revision across all 32 hashed answers executes single-pass conv_scan + Hash Left Join (no `= ANY`).
      historyExplainPlans.length = 0;
      await db.query("UPDATE v3_bitemporal_misconception_edges SET status='retracted' WHERE revision_id=$1", [sharedPerfRev]);
      const perfAfterWithdraw = await loadTutorHistoryContext(sql, scope, histPerfCurrent);
      expect(perfAfterWithdraw.history).toEqual([]);
      expect((await readTutorHistoryAncestorStatus(sql, scope, histPerfCurrent)).valid).toBe(false);
      expect(historyExplainPlans).toHaveLength(2);
      for (const plan of historyExplainPlans) {
        expect(plan["Total Cost"]).toBeLessThan(20_000);
        const nodes = collectNodes(plan);
        const histConvScan = nodes.find(n => n["Subplan Name"] === "CTE conv_scan");
        expect(histConvScan, "expected single-pass CTE conv_scan after shared withdrawal").toBeDefined();
        expect(histConvScan!["Actual Loops"]).toBe(1);
        expect(nodes.some(n => (n.Filter ?? "").includes("assistant_id = ANY") || (n["Join Filter"] ?? "").includes("ANY"))).toBe(false);
        const csInvJoin = nodes.find(n => (n["Hash Cond"] ?? "").includes("assistant_id"));
        expect(csInvJoin, "expected Hash Left Join on assistant_id for cs_inv").toBeDefined();
      }
      await db.query("DELETE FROM v3_bitemporal_misconception_edges WHERE revision_id <> $1", [candidate.revisionId]);
      await db.query("DELETE FROM opening_memories WHERE id = ANY($1::uuid[])", [[joblessPerfMem, ...distinctPerfMems]]);
      await db.query("DELETE FROM opening_tutor_jobs WHERE conversation_id = ANY($1::uuid[])", [[bulkConv, histPerfConv]]);
      await db.query("DELETE FROM opening_turns WHERE conversation_id = ANY($1::uuid[])", [[bulkConv, histPerfConv]]);
      await db.query("DELETE FROM opening_conversations WHERE id = ANY($1::uuid[])", [[bulkConv, histPerfConv]]);
      await db.exec("VACUUM ANALYZE");

      // 4) Round-10 P1 #1: Unbound conversation where Exchange 1 (job-backed, hashless) consumes a memory carrying a Course A
      // misconception (or an ordinary Course A memory), followed by Exchange 2 (job-backed, hashless follow-up, no direct refs).
      // Course B / unbound requests omit BOTH Exchange 1 and Exchange 2; Course A requests retain both and preserve revisions
      // even when Exchange 1 is omitted by the 12,000-character budget.
      const p1Conv = "b0000000-0000-4000-8000-000000000001";
      const p1U1 = "b0000000-0000-4000-8000-000000000002";
      const p1A1 = "b0000000-0000-4000-8000-000000000003";
      const p1U2 = "b0000000-0000-4000-8000-000000000004";
      const p1A2 = "b0000000-0000-4000-8000-000000000005";
      const p1Current = "b0000000-0000-4000-8000-000000000006";
      const p1MemCourseOnly = "b0000000-0000-4000-8000-000000000007";
      await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=$1,status='candidate'", [courseId]);
      await db.query("UPDATE opening_conversations SET course_id=$1 WHERE id=$2", [courseId, originConversation]);
      await db.query("UPDATE opening_turns SET intent_hash=$1,context_source_refs='[]',source_ids='{}' WHERE id=$2",
        [JSON.stringify(exact), originId]);
      await db.query("UPDATE opening_memories SET course_id=$1,kind='confirmed',expires_at=NULL WHERE id=$2", [courseId, memoryId]);
      await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,$3,$4,'confirmed',NULL)",
        [p1MemCourseOnly, scope.workspaceId, courseId, JSON.stringify([cleanOriginId])]);
      await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,NULL)",
        [p1Conv, scope.workspaceId, scope.ownerUserId]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$6,$7,'user','complete',NULL,'[]',$9,false,to_timestamp($10),'Course A Q1'),
               ($2,$6,$7,'assistant','complete',NULL,$8,$9,false,to_timestamp($10),'Course A memory answer'),
               ($3,$6,$7,'user','complete',NULL,'[]',$9,false,to_timestamp($11),'Course A follow-up Q2'),
               ($4,$6,$7,'assistant','complete',NULL,'[]',$9,false,to_timestamp($11),'Hashless derivative A2'),
               ($5,$6,$7,'user','complete',NULL,'[]',$12,false,to_timestamp($13),'Course B Q3')`,
        [p1U1, p1A1, p1U2, p1A2, p1Current, scope.workspaceId, p1Conv,
          JSON.stringify([{ memoryDependencyIds: [memoryId] }]), JSON.stringify({ courseId }),
          baseEpochSec + 20_000, baseEpochSec + 20_010, JSON.stringify({ courseId: otherCourseId }), baseEpochSec + 20_020]);
      await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$5), ($6,$2,$3,$7,$8)",
        [p1A1, scope.workspaceId, p1Conv, p1U1, p1A1, p1A2, p1U2, p1A2]);
      SqlFragment.prototype.execute = origExecute;

      // Course B and unbound turns must NOT receive Exchange 2!
      expect((await loadTutorHistoryContext(sql, scope, p1Current)).history).toEqual([]);
      expect((await readTutorHistoryAncestorStatus(sql, scope, p1Current)).valid).toBe(false);
      await db.query("UPDATE opening_turns SET context_anchor=NULL WHERE id=$1", [p1Current]);
      expect((await loadTutorHistoryContext(sql, scope, p1Current)).history).toEqual([]);
      expect((await readTutorHistoryAncestorStatus(sql, scope, p1Current)).valid).toBe(false);

      // Course A turn retains both exchanges and carries the Course A misconception lineage + courseId collection.
      await db.query("UPDATE opening_turns SET context_anchor=$1 WHERE id=$2", [JSON.stringify({ courseId }), p1Current]);
      const p1CourseAHistory = await loadTutorHistoryContext(sql, scope, p1Current);
      expect(p1CourseAHistory.history.map(t => t.text)).toEqual([
        "Course A Q1", "Course A memory answer", "Course A follow-up Q2", "Hashless derivative A2",
      ]);
      expect(p1CourseAHistory.historyMisconceptionLineage).toEqual(exact);
      const p1CollectedCourses = new Set<string>();
      expect(await readTutorHistoryAncestorStatus(sql, scope, p1Current, { collectCourseIds: p1CollectedCourses }))
        .toMatchObject({ valid: true });
      expect(p1CollectedCourses.has(courseId)).toBe(true);

      // Even when Exchange 1 is omitted by the 12,000-character budget, retained hashless Exchange 2 preserves exact lineage and memoryIds!
      await db.query("UPDATE opening_turns SET text=$1 WHERE id=$2", ["x".repeat(12_000), p1A1]);
      const p1OmittedOlder = await loadTutorHistoryContext(sql, scope, p1Current);
      expect(p1OmittedOlder.history.map(t => t.text)).toEqual(["Course A follow-up Q2", "Hashless derivative A2"]);
      expect(p1OmittedOlder.historyMisconceptionLineage).toEqual(exact);
      expect(p1OmittedOlder.memoryIds).toContain(memoryId);
      await db.query("UPDATE opening_turns SET text='Course A memory answer' WHERE id=$1", [p1A1]);

      // Ordinary Course-A memory (without misconception) consumed in Exchange 1 also prevents hashless Exchange 2 (anchored to Course A
      // or unanchored) from leaking into Course B.
      await db.query("UPDATE opening_turns SET context_source_refs=$1 WHERE id=$2",
        [JSON.stringify([{ memoryDependencyIds: [p1MemCourseOnly] }]), p1A1]);
      await db.query("UPDATE opening_turns SET context_anchor=$1 WHERE id=$2", [JSON.stringify({ courseId: otherCourseId }), p1Current]);
      expect((await loadTutorHistoryContext(sql, scope, p1Current)).history).toEqual([]);
      await db.query("UPDATE opening_turns SET context_anchor=NULL WHERE id=ANY($1::uuid[])", [[p1U2, p1A2]]);
      expect((await loadTutorHistoryContext(sql, scope, p1Current)).history).toEqual([]);

      // 5) Round-10 P2 #4: loadContinuityTurns(..., { userOnly: true }) for exam_help follow-ups returns prior user turns
      // while executing zero opening_memories or conv_scan queries even when prior assistant turns reference memories.
      let examMemoryQueries = 0;
      let examConvScanQueries = 0;
      SqlFragment.prototype.execute = async function (this: SqlFragment) {
        const params: unknown[] = [];
        const rendered = this.render(params).trim();
        if (rendered.includes("opening_memories") || rendered.startsWith("SELECT t.id, ARRAY(")) examMemoryQueries += 1;
        if (rendered.includes("conv_scan")) examConvScanQueries += 1;
        return origExecute.call(this);
      };
      const userOnlyTurns = await repo.loadContinuityTurns(scope, p1Conv, undefined, { userOnly: true });
      expect(userOnlyTurns.map(t => ({ role: t.role, text: t.text }))).toEqual([
        { role: "user", text: "Course A Q1" },
        { role: "user", text: "Course A follow-up Q2" },
        { role: "user", text: "Course B Q3" },
      ]);
      expect(examMemoryQueries).toBe(0);
      expect(examConvScanQueries).toBe(0);

      // 6) Round-11 P1 regressions on PostgreSQL 16.4:
      // (a) Multi-turn readTutorHistoryAncestorAuthority preserves conv_misconception_hashes when u2 is hashed and u1 is hashless;
      // (b) Jobless predecessor with ordinary Course-A memory blocks Course-B / unbound derivative history reuse;
      // (c) Paired user turn (Course A) with Course-A misconception memory + paired assistant (Course B) is rejected in both
      //     loadTutorHistoryContext and readTutorHistoryAncestorStatus.
      SqlFragment.prototype.execute = origExecute;
      const r11Conv = "b1000000-0000-4000-8000-000000000001";
      const r11Jobless = "b1000000-0000-4000-8000-000000000002";
      const r11U1 = "b1000000-0000-4000-8000-000000000003";
      const r11A1 = "b1000000-0000-4000-8000-000000000004";
      const r11U2 = "b1000000-0000-4000-8000-000000000005";
      const r11A2 = "b1000000-0000-4000-8000-000000000006";
      const r11Current = "b1000000-0000-4000-8000-000000000007";
      await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,NULL)", [r11Conv, scope.workspaceId, scope.ownerUserId]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$7,$8,'assistant','complete',NULL,$9,$10,false,to_timestamp($12),'Jobless Course A ordinary mem'),
               ($2,$7,$8,'user','complete',NULL,'[]',$10,false,to_timestamp($13),'R11 Q1'),
               ($3,$7,$8,'assistant','complete',NULL,'[]',$10,false,to_timestamp($13),'R11 hashless A1'),
               ($4,$7,$8,'user','complete',NULL,'[]',$11,false,to_timestamp($14),'R11 Q2'),
               ($5,$7,$8,'assistant','complete',$16,'[]',$11,false,to_timestamp($14),'R11 explicit A2'),
               ($6,$7,$8,'user','complete',NULL,'[]',$11,false,to_timestamp($15),'R11 Course B Current')`,
        [r11Jobless, r11U1, r11A1, r11U2, r11A2, r11Current, scope.workspaceId, r11Conv,
          JSON.stringify([{ memoryDependencyIds: [p1MemCourseOnly] }]),
          JSON.stringify({ courseId }), JSON.stringify({ courseId: otherCourseId }),
          baseEpochSec + 30_000, baseEpochSec + 30_010, baseEpochSec + 30_020, baseEpochSec + 30_030,
          JSON.stringify(cleanLineage)]);
      await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$5), ($6,$2,$3,$7,$8)",
        [r11A1, scope.workspaceId, r11Conv, r11U1, r11A1, r11A2, r11U2, r11A2]);
      await db.exec("ANALYZE");

      // (b) Jobless Course-A ordinary memory prevents R11 hashless A1 from leaking into Course B (leaving only Course-B explicit A2),
      // while Course A retains R11 hashless A1 and propagates p1MemCourseOnly!
      const r11CourseBHistory = await loadTutorHistoryContext(sql, scope, r11Current);
      expect(r11CourseBHistory.history.map(t => t.text)).toEqual(["R11 Q2", "R11 explicit A2"]);
      expect(r11CourseBHistory.memoryIds).toBeUndefined();
      await db.query("UPDATE opening_turns SET context_anchor=$1 WHERE id=$2", [JSON.stringify({ courseId }), r11Current]);
      await db.query("UPDATE opening_turns SET context_anchor=$1 WHERE id=ANY($2::uuid[])", [JSON.stringify({ courseId }), [r11U2, r11A2]]);
      const r11CourseAHistory = await loadTutorHistoryContext(sql, scope, r11Current);
      expect(r11CourseAHistory.history.map(t => t.text)).toEqual(["R11 Q1", "R11 hashless A1", "R11 Q2", "R11 explicit A2"]);
      expect(r11CourseAHistory.memoryIds).toEqual([p1MemCourseOnly]);

      // (a) Multi-turn readTutorHistoryAncestorAuthority([r11U2, r11Current]):
      // Make r11Jobless a hashed Course-A misconception turn, r11A1 hashless in Course A, r11A2 hashless in Course B,
      // and r11Current hashed with cleanLineage in Course B -> r11Current stays valid while r11U2 (preceded by Course-A r11Jobless
      // via hashless r11A1) is rejected even though r11Current's rows held conv_rn = 1!
      const r11CurrentAssistant = "b1000000-0000-4000-8000-000000000008";
      await db.query("UPDATE opening_turns SET intent_hash=$1,context_source_refs='[]' WHERE id=$2", [JSON.stringify(exact), r11Jobless]);
      await db.query("UPDATE opening_turns SET intent_hash=NULL,context_anchor=$1 WHERE id=$2",
        [JSON.stringify({ courseId: otherCourseId }), r11A2]);
      await db.query("UPDATE opening_turns SET context_anchor=$1 WHERE id=ANY($2::uuid[])",
        [JSON.stringify({ courseId: otherCourseId }), [r11U2, r11Current]]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$2,$3,'assistant','complete',$4,'[]',$5,false,to_timestamp($6),'R11 current explicit')`,
        [r11CurrentAssistant, scope.workspaceId, r11Conv, JSON.stringify(cleanLineage),
          JSON.stringify({ courseId: otherCourseId }), baseEpochSec + 30_030]);
      await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$1)",
        [r11CurrentAssistant, scope.workspaceId, r11Conv, r11Current]);
      const multiAuth = await readTutorHistoryAncestorAuthority(sql, scope, [r11U2, r11Current]);
      expect(multiAuth.get(r11Current)).not.toBeNull();
      expect(multiAuth.get(r11U2)).toBeNull();

      // (c) Paired user (Course A) referencing Course-A misconception memory + paired assistant (Course B) is rejected!
      const r11CrossConv = "b1000000-0000-4000-8000-000000000011";
      const r11CrossU1 = "b1000000-0000-4000-8000-000000000012";
      const r11CrossA1 = "b1000000-0000-4000-8000-000000000013";
      const r11CrossNext = "b1000000-0000-4000-8000-000000000014";
      await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,NULL)", [r11CrossConv, scope.workspaceId, scope.ownerUserId]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$4,$5,'user','complete',NULL,$6,$7,false,to_timestamp($9),'Paired Course A user'),
               ($2,$4,$5,'assistant','complete',$11,'[]',$8,false,to_timestamp($9),'Paired Course B assistant'),
               ($3,$4,$5,'user','complete',NULL,'[]',$7,false,to_timestamp($10),'Later Course A user')`,
        [r11CrossU1, r11CrossA1, r11CrossNext, scope.workspaceId, r11CrossConv,
          JSON.stringify([{ memoryDependencyIds: [memoryId] }]),
          JSON.stringify({ courseId }), JSON.stringify({ courseId: otherCourseId }),
          baseEpochSec + 31_000, baseEpochSec + 31_010, JSON.stringify(cleanLineage)]);
      await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$1)",
        [r11CrossA1, scope.workspaceId, r11CrossConv, r11CrossU1]);
      expect((await loadTutorHistoryContext(sql, scope, r11CrossNext)).history).toEqual([]);
      expect((await readTutorHistoryAncestorStatus(sql, scope, r11CrossNext)).valid).toBe(false);

      // 7) Round-12 P1 #1-#3 & P2 #4 on real PostgreSQL 16.4:
      // (a) Mixed-course hashless exchange (u in Course A, a anchored in Course B) after jobless Course-A memory + A/A hashless
      //     exchange is excluded from Course-B loadTutorHistoryContext, while pure B/B hashless exchange remains admitted;
      //     likewise mixed citation-user / practice-assistant hashless exchange is excluded when prefixCitationOnlyOutOfScope is active!
      const r12MixConv = "b2000000-0000-4000-8000-000000000001";
      const r12Jobless = "b2000000-0000-4000-8000-000000000002";
      const r12Uaa = "b2000000-0000-4000-8000-000000000003";
      const r12Aaa = "b2000000-0000-4000-8000-000000000004";
      const r12Uab = "b2000000-0000-4000-8000-000000000005";
      const r12Aab = "b2000000-0000-4000-8000-000000000006";
      const r12Ubb = "b2000000-0000-4000-8000-000000000007";
      const r12Abb = "b2000000-0000-4000-8000-000000000008";
      const r12MixCurrent = "b2000000-0000-4000-8000-000000000009";
      await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,NULL)", [r12MixConv, scope.workspaceId, scope.ownerUserId]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$9,$10,'assistant','complete',NULL,$11,$12,false,to_timestamp($14),'R12 jobless A'),
               ($2,$9,$10,'user','complete',NULL,'[]',$12,false,to_timestamp($15),'R12 Q_AA'),
               ($3,$9,$10,'assistant','complete',NULL,'[]',$12,false,to_timestamp($15),'R12 A_AA'),
               ($4,$9,$10,'user','complete',NULL,'[]',$12,false,to_timestamp($16),'R12 Q_AB'),
               ($5,$9,$10,'assistant','complete',NULL,'[]',$13,false,to_timestamp($16),'R12 A_AB'),
               ($6,$9,$10,'user','complete',NULL,'[]',$13,false,to_timestamp($17),'R12 Q_BB'),
               ($7,$9,$10,'assistant','complete',NULL,'[]',$13,false,to_timestamp($17),'R12 A_BB'),
               ($8,$9,$10,'user','complete',NULL,'[]',$13,false,to_timestamp($18),'R12 Current B')`,
        [r12Jobless, r12Uaa, r12Aaa, r12Uab, r12Aab, r12Ubb, r12Abb, r12MixCurrent, scope.workspaceId, r12MixConv,
          JSON.stringify([{ memoryDependencyIds: [p1MemCourseOnly] }]),
          JSON.stringify({ courseId }), JSON.stringify({ courseId: otherCourseId }),
          baseEpochSec + 40_000, baseEpochSec + 40_010, baseEpochSec + 40_020, baseEpochSec + 40_030, baseEpochSec + 40_040]);
      await db.query(`INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id)
        VALUES ($1,$2,$3,$4,$1), ($5,$2,$3,$6,$5), ($7,$2,$3,$8,$7)`,
        [r12Aaa, scope.workspaceId, r12MixConv, r12Uaa, r12Aab, r12Uab, r12Abb, r12Ubb]);
      const r12MixedCourseRes = await loadTutorHistoryContext(sql, scope, r12MixCurrent);
      expect(r12MixedCourseRes.history.map(t => t.text)).toEqual(["R12 Q_BB", "R12 A_BB"]);
      expect(r12MixedCourseRes.memoryIds).toBeUndefined();

      // Symmetric citation-only memory in Course B + practice request: mixed citation-user / practice-assistant excluded!
      const r12RefSrc = "b2000000-0000-4000-8000-000000000010";
      const r12RefOrigin = "b2000000-0000-4000-8000-000000000011";
      const r12CitMemB = "b2000000-0000-4000-8000-000000000012";
      const r12ItemId = "b2000000-0000-4000-8000-000000000013";
      await db.query("INSERT INTO opening_sources (id,workspace_id,version,upload_state) VALUES ($1,$2,1,'uploaded')", [r12RefSrc, scope.workspaceId]);
      await db.query("INSERT INTO course_asset_memberships (id,workspace_id,course_id,asset_id,asset_type,purpose) VALUES ($1,$2,$3,$4,'source','reference')",
        [r12RefSrc, scope.workspaceId, otherCourseId, r12RefSrc]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,source_ids,source_versions,
          context_source_refs,context_anchor,query_system,created_at,text)
        VALUES ($1,$2,$3,'user','complete',ARRAY[$4]::uuid[],jsonb_build_object($4::text,1),'[]',$5,false,to_timestamp($6),'Ref origin')`,
        [r12RefOrigin, scope.workspaceId, r12MixConv, r12RefSrc, JSON.stringify({ courseId: otherCourseId }), baseEpochSec + 39_900]);
      await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,$3,$4,'confirmed',NULL)",
        [r12CitMemB, scope.workspaceId, otherCourseId, JSON.stringify([r12RefOrigin])]);
      await db.query("UPDATE opening_turns SET context_source_refs=$1,context_anchor=$2 WHERE id=$3",
        [JSON.stringify([{ memoryDependencyIds: [r12CitMemB] }]), JSON.stringify({ courseId: otherCourseId }), r12Jobless]);
      await db.query("UPDATE opening_turns SET context_anchor=$1 WHERE id=ANY($2::uuid[])",
        [JSON.stringify({ courseId: otherCourseId }), [r12Uaa, r12Aaa, r12Uab]]);
      await db.query("UPDATE opening_turns SET context_anchor=$1 WHERE id=ANY($2::uuid[])",
        [JSON.stringify({ courseId: otherCourseId, itemVersionId: r12ItemId }), [r12Aab, r12Ubb, r12Abb, r12MixCurrent]]);
      const r12MixedUseRes = await loadTutorHistoryContext(sql, scope, r12MixCurrent);
      expect(r12MixedUseRes.history.map(t => t.text)).toEqual(["R12 Q_BB", "R12 A_BB"]);

      // (b) Paired-user Course-A misconception memory + paired-assistant in Course B followed by hashless Course-A answer:
      //     listTurns, listSummaries, and releaseReturnedTurnIds redact the hashless Course-A answer and leave released_at NULL!
      const r12CrossHashlessU = "b2000000-0000-4000-8000-000000000021";
      const r12CrossHashlessA = "b2000000-0000-4000-8000-000000000022";
      const r12CrossReceipt = "b2000000-0000-4000-8000-000000000023";
      const r12CrossDerivedMem = "b2000000-0000-4000-8000-000000000024";
      await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=$1,status='candidate' WHERE revision_id=$2",
        [courseId, candidate.revisionId]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$3,$4,'user','complete',NULL,'[]',$5,false,to_timestamp($6),'Hashless Course A follow-up Q'),
               ($2,$3,$4,'assistant','complete',NULL,'[]',$5,false,to_timestamp($7),'Hashless Course A follow-up A')`,
        [r12CrossHashlessU, r12CrossHashlessA, scope.workspaceId, r11CrossConv,
          JSON.stringify({ courseId }), baseEpochSec + 31_020, baseEpochSec + 31_021]);
      await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$1)",
        [r12CrossHashlessA, scope.workspaceId, r11CrossConv, r12CrossHashlessU]);
      await db.query(`INSERT INTO opening_help_exposures (id,workspace_id,owner_user_id,course_id,turn_id,exposure_origin,release_key,context_anchor,released_at)
        VALUES ($1,$2,$3,$4,$5,'assistant','r12-cross-receipt',$6,NULL)`,
        [r12CrossReceipt, scope.workspaceId, scope.ownerUserId, courseId, r12CrossHashlessA, JSON.stringify({ purpose: "learning_help", courseId })]);
      await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,$3,$4,'confirmed',NULL)",
        [r12CrossDerivedMem, scope.workspaceId, courseId, JSON.stringify([r12CrossHashlessA])]);
      const r12CrossTurns = await repo.listTurns(scope, r11CrossConv);
      const r12CrossTurnRow = r12CrossTurns.find(t => t.id === r12CrossHashlessA);
      expect(r12CrossTurnRow).toMatchObject({ id: r12CrossHashlessA, text: unavailable });
      expect(r12CrossTurnRow?.exposureReceipt).toBeUndefined();
      expect(await repo.listSummaries(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: r11CrossConv, lastTurnPreview: unavailable }),
      ]));
      expect(await repo.releaseReturnedTurnIds(scope, r11CrossConv, [r12CrossHashlessA])).toEqual([
        { id: r12CrossHashlessA, role: "assistant", text: unavailable, citations: [] },
      ]);
      expect((await db.query<{ released_at: string | null }>("SELECT released_at FROM opening_help_exposures WHERE id=$1", [r12CrossReceipt])).rows[0]?.released_at)
        .toBeNull();
      expect(await sourceTurnsAllowMisconceptionMemory(sql, scope, [r12CrossHashlessA], courseId)).toBe(false);
      expect(await readMemoryMisconceptionLineages(sql, scope, [r12CrossDerivedMem], courseId)).toEqual(new Map());

      // (c) Temporary memory expiry before first delivery vs already-released receipt before expiry on PG 16.4:
      const r12ExpConv1 = "b2000000-0000-4000-8000-000000000031";
      const r12ExpConv2 = "b2000000-0000-4000-8000-000000000032";
      const r12ExpConv3 = "b2000000-0000-4000-8000-000000000033";
      const r12ExpTempMem = "b2000000-0000-4000-8000-000000000034";
      const r12ExpConfMem = "b2000000-0000-4000-8000-000000000035";
      const r12DeliveredTurn = "b2000000-0000-4000-8000-000000000036";
      const r12DirectTurn = "b2000000-0000-4000-8000-000000000037";
      const r12TransTurn = "b2000000-0000-4000-8000-000000000038";
      const r12PrefixTurn = "b2000000-0000-4000-8000-000000000039";
      const r12DeliveredRec = "b2000000-0000-4000-8000-000000000041";
      const r12DirectRec = "b2000000-0000-4000-8000-000000000042";
      const r12TransRec = "b2000000-0000-4000-8000-000000000043";
      const r12PrefixRec = "b2000000-0000-4000-8000-000000000044";
      const r12FutureIso = new Date(Date.now() + 120_000).toISOString();
      await db.query("INSERT INTO opening_conversations VALUES ($1,$4,$5,$6), ($2,$4,$5,$6), ($3,$4,$5,$6)",
        [r12ExpConv1, r12ExpConv2, r12ExpConv3, scope.workspaceId, scope.ownerUserId, courseId]);
      await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,$3,$4,'temporary',$5)",
        [r12ExpTempMem, scope.workspaceId, courseId, JSON.stringify([cleanOriginId]), r12FutureIso]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$2,$3,'assistant','complete',NULL,$4,$5,false,to_timestamp($6),'Delivered before expiry')`,
        [r12DeliveredTurn, scope.workspaceId, r12ExpConv1, JSON.stringify([{ memoryDependencyIds: [r12ExpTempMem] }]),
          JSON.stringify({ courseId }), baseEpochSec + 41_000]);
      await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,$3,$4,'confirmed',NULL)",
        [r12ExpConfMem, scope.workspaceId, courseId, JSON.stringify([r12DeliveredTurn])]);
      await db.query(`INSERT INTO opening_help_exposures (id,workspace_id,owner_user_id,course_id,turn_id,exposure_origin,release_key,context_anchor,released_at)
        VALUES ($1,$2,$3,$4,$5,'assistant','r12-delivered-rec',$6,NULL)`,
        [r12DeliveredRec, scope.workspaceId, scope.ownerUserId, courseId, r12DeliveredTurn, JSON.stringify({ purpose: "learning_help", courseId })]);

      // Deliver r12DeliveredTurn BEFORE expiry -> releases its exposure receipt!
      const beforeExpTurns = await repo.listTurns(scope, r12ExpConv1);
      expect(beforeExpTurns).toMatchObject([{ id: r12DeliveredTurn, text: "Delivered before expiry" }]);
      expect(beforeExpTurns[0]?.exposureReceipt?.releasedAt).toEqual(expect.any(String));

      // Generate 3 unreleased answers (prefix-inherited in conv1, direct in conv2, transitive-memory in conv3), then expire r12ExpTempMem!
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$4,$5,'assistant','complete',NULL,'[]',$8,false,to_timestamp($11),'Prefix unreleased after expiry'),
               ($2,$4,$6,'assistant','complete',NULL,$9,$8,false,to_timestamp($11),'Direct unreleased after expiry'),
               ($3,$4,$7,'assistant','complete',NULL,$10,$8,false,to_timestamp($11),'Transitive unreleased after expiry')`,
        [r12PrefixTurn, r12DirectTurn, r12TransTurn, scope.workspaceId, r12ExpConv1, r12ExpConv2, r12ExpConv3,
          JSON.stringify({ courseId }), JSON.stringify([{ memoryDependencyIds: [r12ExpTempMem] }]),
          JSON.stringify([{ memoryDependencyIds: [r12ExpConfMem] }]), baseEpochSec + 41_010]);
      await db.query(`INSERT INTO opening_help_exposures (id,workspace_id,owner_user_id,course_id,turn_id,exposure_origin,release_key,context_anchor,released_at)
        VALUES ($1,$4,$5,$6,$7,'assistant','r12-prefix-rec',$10,NULL),
               ($2,$4,$5,$6,$8,'assistant','r12-direct-rec',$10,NULL),
               ($3,$4,$5,$6,$9,'assistant','r12-trans-rec',$10,NULL)`,
        [r12PrefixRec, r12DirectRec, r12TransRec, scope.workspaceId, scope.ownerUserId, courseId,
          r12PrefixTurn, r12DirectTurn, r12TransTurn, JSON.stringify({ purpose: "learning_help", courseId })]);
      await db.query("UPDATE opening_memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r12ExpTempMem]);
      await db.exec("ANALYZE");

      const afterExpConv1 = await repo.listTurns(scope, r12ExpConv1);
      expect(afterExpConv1.map(t => ({ id: t.id, text: t.text, hasReceipt: Boolean(t.exposureReceipt) }))).toEqual([
        { id: r12DeliveredTurn, text: "Delivered before expiry", hasReceipt: true },
        { id: r12PrefixTurn, text: unavailable, hasReceipt: false },
      ]);
      expect(await repo.listTurns(scope, r12ExpConv2)).toMatchObject([{ id: r12DirectTurn, text: unavailable }]);
      expect(await repo.listTurns(scope, r12ExpConv3)).toMatchObject([{ id: r12TransTurn, text: unavailable }]);
      const afterExpSummaries = await repo.listSummaries(scope);
      expect(afterExpSummaries).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: r12ExpConv1, lastTurnPreview: unavailable }),
        expect.objectContaining({ id: r12ExpConv2, lastTurnPreview: unavailable }),
        expect.objectContaining({ id: r12ExpConv3, lastTurnPreview: unavailable }),
      ]));
      expect(await repo.releaseReturnedTurnIds(scope, r12ExpConv1, [r12DeliveredTurn, r12PrefixTurn])).toEqual([
        { id: r12DeliveredTurn, role: "assistant", text: "Delivered before expiry", citations: [] },
        { id: r12PrefixTurn, role: "assistant", text: unavailable, citations: [] },
      ]);
      expect(await repo.releaseReturnedTurnIds(scope, r12ExpConv2, [r12DirectTurn])).toEqual([
        { id: r12DirectTurn, role: "assistant", text: unavailable, citations: [] },
      ]);
      expect(await repo.releaseReturnedTurnIds(scope, r12ExpConv3, [r12TransTurn])).toEqual([
        { id: r12TransTurn, role: "assistant", text: unavailable, citations: [] },
      ]);
      const unreleasedRows = (await db.query<{ id: string; released_at: string | null }>(
        "SELECT id, released_at FROM opening_help_exposures WHERE id = ANY($1::uuid[])",
        [[r12PrefixRec, r12DirectRec, r12TransRec]],
      )).rows;
      expect(unreleasedRows).toHaveLength(3);
      expect(unreleasedRows.every(r => r.released_at === null)).toBe(true);

      // Once conv1's unreleased turn is removed so r12DeliveredTurn is the latest turn, listSummaries keeps r12DeliveredTurn visible!
      await db.query("DELETE FROM opening_turns WHERE id=$1", [r12PrefixTurn]);
      expect(await repo.listSummaries(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: r12ExpConv1, lastTurnPreview: "Delivered before expiry" }),
      ]));

      // (d) 64 jobless origins with distinct memory IDs + 64 hashless exchanges on PG 16.4 scale linearly (< 200 ms JS):
      const r12ScaleConv = "b3000000-0000-4000-8000-000000000001";
      const r12ScaleCurrent = "b3000000-0000-4000-8000-000000000002";
      const r12ScaleMems = Array.from({ length: 64 }, (_, k) => `b3000010-0000-4000-8000-${String(k + 1).padStart(12, "0")}`);
      await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,$4)",
        [r12ScaleConv, scope.workspaceId, scope.ownerUserId, courseId]);
      for (let k = 0; k < 64; k++) {
        await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,$3,$4,'confirmed',NULL)",
          [r12ScaleMems[k]!, scope.workspaceId, courseId, JSON.stringify([cleanOriginId])]);
        const jId = `b3000020-0000-4000-8000-${String(k + 1).padStart(12, "0")}`;
        await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,
            context_source_refs,context_anchor,query_system,created_at,text)
          VALUES ($1,$2,$3,'assistant','complete',NULL,$4,$5,false,to_timestamp($6),$7)`,
          [jId, scope.workspaceId, r12ScaleConv, JSON.stringify([{ memoryDependencyIds: [r12ScaleMems[k]!] }]),
            JSON.stringify({ courseId }), baseEpochSec + 50_000 + k, `ScaleJobless#${k + 1}`]);
      }
      for (let k = 0; k < 64; k++) {
        const uId = `b3000030-0000-4000-8000-${String(k + 1).padStart(12, "0")}`;
        const aId = `b3000040-0000-4000-8000-${String(k + 1).padStart(12, "0")}`;
        await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,
            context_source_refs,context_anchor,query_system,created_at,text)
          VALUES ($1,$3,$4,'user','complete',NULL,'[]',$5,false,to_timestamp($6),$7),
                 ($2,$3,$4,'assistant','complete',NULL,'[]',$5,false,to_timestamp($6),$8)`,
          [uId, aId, scope.workspaceId, r12ScaleConv, JSON.stringify({ courseId }),
            baseEpochSec + 51_000 + k * 2, `SQ${k + 1}`, `SA${k + 1}`]);
        await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$1)",
          [aId, scope.workspaceId, r12ScaleConv, uId]);
      }
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,context_source_refs,
          context_anchor,query_system,created_at,text)
        VALUES ($1,$2,$3,'user','complete','[]',$4,false,to_timestamp($5),'SQ65')`,
        [r12ScaleCurrent, scope.workspaceId, r12ScaleConv, JSON.stringify({ courseId }), baseEpochSec + 52_000]);
      await db.exec("ANALYZE");
      SqlFragment.prototype.execute = async function (this: SqlFragment) {
        const params: unknown[] = [];
        const rendered = this.render(params).trim();
        if (rendered.startsWith("SELECT id FROM opening_memories AS m(memory_id)")) {
          const analyzed = await db.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
            "EXPLAIN (ANALYZE, FORMAT JSON) " + rendered, params);
          const batchIds = Array.isArray(params[1]) ? params[1].length : 1;
          expect(analyzed.rows[0]!["QUERY PLAN"][0]!.Plan["Total Cost"] / Math.max(1, batchIds)).toBeLessThan(20_000);
          return (await db.query(rendered, params)).rows;
        }
        return origExecute.call(this);
      };
      const scaleStart = performance.now();
      const scaleRes = await loadTutorHistoryContext(sql, scope, r12ScaleCurrent);
      expect(performance.now() - scaleStart).toBeLessThan(500);
      expect(scaleRes.history).toHaveLength(40);
      expect(scaleRes.memoryIds).toEqual([...r12ScaleMems].sort());
      expect(scaleRes.historyCourseBindings).toEqual([
        { courseId, materialUse: "citation", sourceIds: [], sourceRefs: [], memoryIds: [...r12ScaleMems].sort() },
      ]);

      // 8) Round-13 P1 #1/#2 & P2 #3/#4 on real PostgreSQL 16.4 (< 20,000 EXPLAIN cost gate active):
      SqlFragment.prototype.execute = origExecute;
      useRealTx = true;

      // (a) P1 #1: Temporary memory expiring mid-release (after locked reread & revision increments, right before UPDATE opening_help_exposures)
      // rolls back its savepoint (no orphaned history_revision / workspace_history_revision), leaves released_at NULL, and redacts in
      // listTurns / listSummaries / releaseReturnedTurnIds while releasing an earlier valid receipt in the same batch!
      const r13ExpConv = "b4000000-0000-4000-8000-000000000001";
      const r13ExpTempMem = "b4000000-0000-4000-8000-000000000002";
      const r13Turn1 = "b4000000-0000-4000-8000-000000000003";
      const r13Turn2 = "b4000000-0000-4000-8000-000000000004";
      const r13Rec1 = "b4000000-0000-4000-8000-000000000005";
      const r13Rec2 = "b4000000-0000-4000-8000-000000000006";
      await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,$4)",
        [r13ExpConv, scope.workspaceId, scope.ownerUserId, courseId]);
      const resetR13ExpiryFixture = async () => {
        const freshFutureIso = new Date(Date.now() + 120_000).toISOString();
        await db.query(`INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at)
          VALUES ($1,$2,$3,$4,'temporary',$5)
          ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at, status = 'active'`,
          [r13ExpTempMem, scope.workspaceId, courseId, JSON.stringify([cleanOriginId]), freshFutureIso]);
        await db.query("DELETE FROM opening_help_exposures WHERE id = ANY($1::uuid[])", [[r13Rec1, r13Rec2]]);
        await db.query("DELETE FROM opening_turns WHERE id = ANY($1::uuid[])", [[r13Turn1, r13Turn2]]);
        await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
            context_anchor,query_system,created_at,text)
          VALUES ($1,$3,$4,'assistant','complete',NULL,'[]',$6,false,to_timestamp($7),'R13 valid confirmed turn'),
                 ($2,$3,$4,'assistant','complete',NULL,$5,$6,false,to_timestamp($8),'R13 mid-release expiring turn')`,
          [r13Turn1, r13Turn2, scope.workspaceId, r13ExpConv,
            JSON.stringify([{ memoryDependencyIds: [r13ExpTempMem] }]),
            JSON.stringify({ courseId }), baseEpochSec + 60_000, baseEpochSec + 60_001]);
        await db.query(`INSERT INTO opening_help_exposures (id,workspace_id,owner_user_id,course_id,turn_id,exposure_origin,release_key,context_anchor,released_at)
          VALUES ($1,$3,$4,$5,$6,'assistant','r13-rec-1',$8,NULL),
                 ($2,$3,$4,$5,$7,'assistant','r13-rec-2',$8,NULL)`,
          [r13Rec1, r13Rec2, scope.workspaceId, scope.ownerUserId, courseId, r13Turn1, r13Turn2,
            JSON.stringify({ purpose: "learning_help", courseId })]);
        return freshFutureIso;
      };
      // Hook SqlFragment.execute so right before UPDATE opening_help_exposures for r13Rec2 (AFTER nextLearningHistoryRevision &
      // nextWorkspaceLearningHistoryRevision ran inside the savepoint!), clock_timestamp() > $expiresAt holds by shifting the
      // bound deadline parameter into the past (simulating wall-clock passing the deadline mid-savepoint)!
      const installMidSavepointExpiryHook = () => {
        SqlFragment.prototype.execute = async function (this: SqlFragment) {
          const params: unknown[] = [];
          const rendered = this.render(params).trim();
          if (rendered.startsWith("UPDATE opening_help_exposures") && rendered.includes("clock_timestamp() <") && params.includes(r13Rec2)) {
            const pastIso = new Date(Date.now() - 5_000).toISOString();
            params[params.length - 1] = pastIso;
            return (await db.query(rendered, params)).rows;
          }
          return origExecute.call(this);
        };
      };

      await resetR13ExpiryFixture();
      const readRevs = async () => ({
        courseRev: Number((await db.query<{ revision: string }>(
          "SELECT COALESCE((SELECT revision FROM opening_learning_history_revisions WHERE workspace_id=$1 AND owner_user_id=$2 AND course_id=$3), 0)::text AS revision",
          [scope.workspaceId, scope.ownerUserId, courseId],
        )).rows[0]!.revision),
        wsRev: Number((await db.query<{ revision: string }>(
          "SELECT COALESCE((SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=$1), 0)::text AS revision",
          [scope.workspaceId],
        )).rows[0]!.revision),
      });
      const revsBeforeList = await readRevs();
      installMidSavepointExpiryHook();
      const r13ListedTurns = await repo.listTurns(scope, r13ExpConv);
      SqlFragment.prototype.execute = origExecute;
      expect(r13ListedTurns.map(t => ({ id: t.id, text: t.text, hasReceipt: Boolean(t.exposureReceipt) }))).toEqual([
        { id: r13Turn1, text: "R13 valid confirmed turn", hasReceipt: true },
        { id: r13Turn2, text: unavailable, hasReceipt: false },
      ]);
      const revsAfterList = await readRevs();
      // Only r13Rec1 incremented revisions (+1); r13Rec2's savepoint rolled back its revision increments!
      expect(revsAfterList.courseRev).toBe(revsBeforeList.courseRev + 1);
      expect(revsAfterList.wsRev).toBe(revsBeforeList.wsRev + 1);
      expect((await db.query<{ released_at: string | null }>("SELECT released_at FROM opening_help_exposures WHERE id=$1", [r13Rec2])).rows[0]?.released_at)
        .toBeNull();

      await resetR13ExpiryFixture();
      const revsBeforeSum = await readRevs();
      // Delete r13Turn1's pending receipt so r13Turn2 (the latest turn) is the preview turn in listSummaries:
      await db.query("DELETE FROM opening_help_exposures WHERE id=$1", [r13Rec1]);
      installMidSavepointExpiryHook();
      const r13Summaries = await repo.listSummaries(scope);
      SqlFragment.prototype.execute = origExecute;
      expect(r13Summaries).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: r13ExpConv, lastTurnPreview: unavailable }),
      ]));
      expect(await readRevs()).toEqual(revsBeforeSum);
      expect((await db.query<{ released_at: string | null }>("SELECT released_at FROM opening_help_exposures WHERE id=$1", [r13Rec2])).rows[0]?.released_at)
        .toBeNull();

      await resetR13ExpiryFixture();
      const revsBeforeResume = await readRevs();
      installMidSavepointExpiryHook();
      const r13Resumed = await repo.releaseReturnedTurnIds(scope, r13ExpConv, [r13Turn1, r13Turn2]);
      SqlFragment.prototype.execute = origExecute;
      expect(r13Resumed).toEqual([
        { id: r13Turn1, role: "assistant", text: "R13 valid confirmed turn", citations: [] },
        { id: r13Turn2, role: "assistant", text: unavailable, citations: [] },
      ]);
      const revsAfterResume = await readRevs();
      expect(revsAfterResume.courseRev).toBe(revsBeforeResume.courseRev + 1);
      expect(revsAfterResume.wsRev).toBe(revsBeforeResume.wsRev + 1);
      expect((await db.query<{ released_at: string | null }>("SELECT released_at FROM opening_help_exposures WHERE id=$1", [r13Rec2])).rows[0]?.released_at)
        .toBeNull();

      // (b) P1 #2: Unbound conversation A/A (BOTH hashed Course-A misconception AND memory-bearing Course-A misconception) ->
      // intermediate hashless B (both job-backed and jobless, no direct memory refs) -> final hashless A (pending receipt):
      // listTurns, listSummaries, releaseReturnedTurnIds, sourceTurnsAllowMisconceptionMemory, readMemoryMisconceptionLineages,
      // loadTutorHistoryContext, and readTutorHistoryAncestorStatus ALL reject/redact final A and leave released_at NULL!
      await db.query("UPDATE v3_bitemporal_misconception_edges SET course_id=$1,status='candidate' WHERE revision_id=$2",
        [courseId, candidate.revisionId]);
      await db.query("UPDATE opening_conversations SET course_id=$1 WHERE id=$2", [courseId, originConversation]);
      await db.query("UPDATE opening_turns SET intent_hash=$1,context_source_refs='[]',source_ids='{}' WHERE id=$2",
        [JSON.stringify(exact), originId]);
      await db.query("UPDATE opening_memories SET course_id=$1,kind='confirmed',expires_at=NULL WHERE id=$2", [courseId, memoryId]);

      for (const [tag, hashedOrigin, joblessB] of [
        ["hashed-jobB", true, false],
        ["hashed-joblessB", true, true],
        ["mem-jobB", false, false],
        ["mem-joblessB", false, true],
      ] as const) {
        const idx = ["hashed-jobB", "hashed-joblessB", "mem-jobB", "mem-joblessB"].indexOf(tag) + 1;
        const pfx = `b410000${idx}-0000-4000-8000-0000000000`;
        const cId = `${pfx}01`, u1 = `${pfx}02`, a1 = `${pfx}03`, u2 = `${pfx}04`, a2 = `${pfx}05`;
        const u3 = `${pfx}06`, a3 = `${pfx}07`, rec3 = `${pfx}08`, derMem = `${pfx}09`, curA = `${pfx}10`;
        await db.query("INSERT INTO opening_conversations VALUES ($1,$2,$3,NULL)", [cId, scope.workspaceId, scope.ownerUserId]);
        await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
            context_anchor,query_system,created_at,text)
          VALUES ($1,$7,$8,'user','complete',NULL,'[]',$11,false,to_timestamp($13),'Q1 A'),
                 ($2,$7,$8,'assistant','complete',$9,$10,$11,false,to_timestamp($13),'A1 A'),
                 ($3,$7,$8,'assistant','complete',NULL,'[]',$12,false,to_timestamp($14),'A2 hashless B'),
                 ($4,$7,$8,'user','complete',NULL,'[]',$11,false,to_timestamp($15),'Q3 A'),
                 ($5,$7,$8,'assistant','complete',NULL,'[]',$11,false,to_timestamp($15),'A3 hashless A'),
                 ($6,$7,$8,'user','complete',NULL,'[]',$11,false,to_timestamp($16),'Current A')`,
          [u1, a1, a2, u3, a3, curA, scope.workspaceId, cId,
            hashedOrigin ? JSON.stringify(exact) : null,
            hashedOrigin ? "[]" : JSON.stringify([{ memoryDependencyIds: [memoryId] }]),
            JSON.stringify({ courseId }), JSON.stringify({ courseId: otherCourseId }),
            baseEpochSec + 61_000, baseEpochSec + 61_010, baseEpochSec + 61_020, baseEpochSec + 61_030]);
        await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$1), ($5,$2,$3,$6,$5)",
          [a1, scope.workspaceId, cId, u1, a3, u3]);
        if (!joblessB) {
          await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,
              context_anchor,query_system,created_at,text)
            VALUES ($1,$2,$3,'user','complete',NULL,'[]',$4,false,to_timestamp($5),'Q2 B')`,
            [u2, scope.workspaceId, cId, JSON.stringify({ courseId: otherCourseId }), baseEpochSec + 61_010]);
          await db.query("INSERT INTO opening_tutor_jobs (id,workspace_id,conversation_id,user_turn_id,assistant_turn_id) VALUES ($1,$2,$3,$4,$1)",
            [a2, scope.workspaceId, cId, u2]);
        }
        await db.query(`INSERT INTO opening_help_exposures (id,workspace_id,owner_user_id,course_id,turn_id,exposure_origin,release_key,context_anchor,released_at)
          VALUES ($1,$2,$3,$4,$5,'assistant',$6,$7,NULL)`,
          [rec3, scope.workspaceId, scope.ownerUserId, courseId, a3, `r13-${tag}`, JSON.stringify({ purpose: "learning_help", courseId })]);
        await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,$3,$4,'confirmed',NULL)",
          [derMem, scope.workspaceId, courseId, JSON.stringify([a3])]);
        await db.exec("ANALYZE");

        const turnsRes = await repo.listTurns(scope, cId);
        const finalRow = turnsRes.find(t => t.id === a3);
        expect(finalRow, tag).toMatchObject({ id: a3, text: unavailable });
        expect(finalRow?.exposureReceipt, tag).toBeUndefined();
        expect(await repo.releaseReturnedTurnIds(scope, cId, [a3]), tag).toEqual([
          { id: a3, role: "assistant", text: unavailable, citations: [] },
        ]);
        // Delete curA temporarily to check listSummaries when a3 is the latest turn:
        await db.query("UPDATE opening_turns SET created_at=to_timestamp($1) WHERE id=$2", [baseEpochSec + 61_040, a3]);
        expect(await repo.listSummaries(scope), tag).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: cId, lastTurnPreview: unavailable }),
        ]));
        await db.query("UPDATE opening_turns SET created_at=to_timestamp($1) WHERE id=$2", [baseEpochSec + 61_020, a3]);
        expect((await db.query<{ released_at: string | null }>("SELECT released_at FROM opening_help_exposures WHERE id=$1", [rec3])).rows[0]?.released_at, tag)
          .toBeNull();
        expect(await sourceTurnsAllowMisconceptionMemory(sql, scope, [a3], courseId), tag).toBe(false);
        expect(await readMemoryMisconceptionLineages(sql, scope, [derMem], courseId), tag).toEqual(new Map());
        expect((await loadTutorHistoryContext(sql, scope, curA)).history, tag).toEqual([
          { role: "user", text: "Q1 A" },
          { role: "assistant", text: "A1 A" },
        ]);
        expect((await readTutorHistoryAncestorStatus(sql, scope, curA)).valid, tag).toBe(false);
      }

      // (c) P2 #3: Standalone legacy memoryOnly: true (no memoryDependencyIds) backed solely by a temporary memory:
      // already-delivered turn remains visible after temporary backing expires (until misconception withdrawal),
      // whereas unreleased turn is redacted and leaves released_at NULL!
      const r13LegConv1 = "b4200000-0000-4000-8000-000000000001";
      const r13LegConv2 = "b4200000-0000-4000-8000-000000000002";
      const r13LegSrc = "b4200000-0000-4000-8000-000000000003";
      const r13LegOrigin = "b4200000-0000-4000-8000-000000000004";
      const r13LegTempBacking = "b4200000-0000-4000-8000-000000000005";
      const r13LegDelivered = "b4200000-0000-4000-8000-000000000006";
      const r13LegUnreleased = "b4200000-0000-4000-8000-000000000007";
      const r13LegDelRec = "b4200000-0000-4000-8000-000000000008";
      const r13LegUnrelRec = "b4200000-0000-4000-8000-000000000009";
      const r13GlobalRev = "b4200000-0000-4000-8000-000000000010";
      const r13GlobalLin = { kind: "v3_misconception_lineage" as const, courseId: null, revisionIds: [r13GlobalRev] };
      await db.query("INSERT INTO v3_bitemporal_misconception_edges VALUES ($1,$2,$3,NULL,7,'(,)','(,)','candidate')",
        [r13GlobalRev, scope.workspaceId, scope.ownerUserId]);
      await db.query("INSERT INTO opening_sources (id,workspace_id,version,upload_state) VALUES ($1,$2,1,'uploaded')",
        [r13LegSrc, scope.workspaceId]);
      await db.query("INSERT INTO opening_conversations VALUES ($1,$3,$4,NULL), ($2,$3,$4,NULL)",
        [r13LegConv1, r13LegConv2, scope.workspaceId, scope.ownerUserId]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,source_ids,source_versions,
          context_source_refs,query_system,created_at,text)
        VALUES ($1,$2,$3,'assistant','complete',$4,ARRAY[$5]::uuid[],jsonb_build_object($5::text,1),$6,false,to_timestamp($7),'Legacy temp backing origin')`,
        [r13LegOrigin, scope.workspaceId, r13LegConv1, JSON.stringify(r13GlobalLin), r13LegSrc,
          JSON.stringify([{ sourceId: r13LegSrc, sourceVersion: 1 }]), baseEpochSec + 62_000]);
      await db.query("INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at) VALUES ($1,$2,NULL,$3,'temporary',$4)",
        [r13LegTempBacking, scope.workspaceId, JSON.stringify([r13LegOrigin]), new Date(Date.now() + 120_000).toISOString()]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,query_system,created_at,text)
        VALUES ($1,$2,$3,'assistant','complete',NULL,$4,false,to_timestamp($5),'Delivered legacy memoryOnly')`,
        [r13LegDelivered, scope.workspaceId, r13LegConv1,
          JSON.stringify([{ sourceId: r13LegSrc, sourceVersion: 1, memoryOnly: true }]), baseEpochSec + 62_010]);
      await db.query(`INSERT INTO opening_help_exposures (id,workspace_id,owner_user_id,course_id,turn_id,exposure_origin,release_key,context_anchor,released_at)
        VALUES ($1,$2,$3,NULL,$4,'assistant','r13-leg-del-rec',$5,NULL)`,
        [r13LegDelRec, scope.workspaceId, scope.ownerUserId, r13LegDelivered, JSON.stringify({ purpose: "learning_help" })]);

      // Deliver r13LegDelivered while r13LegTempBacking is unexpired:
      const preExpLeg = await repo.listTurns(scope, r13LegConv1);
      expect(preExpLeg.find(t => t.id === r13LegDelivered)).toMatchObject({
        id: r13LegDelivered, text: "Delivered legacy memoryOnly",
        exposureReceipt: expect.objectContaining({ id: r13LegDelRec, releasedAt: expect.any(String) }),
      });

      // Add unreleased legacy memoryOnly turn in r13LegConv2, then expire r13LegTempBacking:
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,context_source_refs,query_system,created_at,text)
        VALUES ($1,$2,$3,'assistant','complete',NULL,$4,false,to_timestamp($5),'Unreleased legacy memoryOnly')`,
        [r13LegUnreleased, scope.workspaceId, r13LegConv2,
          JSON.stringify([{ sourceId: r13LegSrc, sourceVersion: 1, memoryOnly: true }]), baseEpochSec + 62_020]);
      await db.query(`INSERT INTO opening_help_exposures (id,workspace_id,owner_user_id,course_id,turn_id,exposure_origin,release_key,context_anchor,released_at)
        VALUES ($1,$2,$3,NULL,$4,'assistant','r13-leg-unrel-rec',$5,NULL)`,
        [r13LegUnrelRec, scope.workspaceId, scope.ownerUserId, r13LegUnreleased, JSON.stringify({ purpose: "learning_help" })]);
      await db.query("UPDATE opening_memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [r13LegTempBacking]);
      await db.exec("ANALYZE");

      // Already-delivered stays visible; unreleased is redacted and its receipt stays NULL!
      expect((await repo.listTurns(scope, r13LegConv1)).find(t => t.id === r13LegDelivered))
        .toMatchObject({ id: r13LegDelivered, text: "Delivered legacy memoryOnly" });
      const postExpUnrel = await repo.listTurns(scope, r13LegConv2);
      expect(postExpUnrel).toMatchObject([{ id: r13LegUnreleased, text: unavailable }]);
      expect(postExpUnrel[0]?.exposureReceipt).toBeUndefined();
      expect(await repo.listSummaries(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: r13LegConv1, lastTurnPreview: "Delivered legacy memoryOnly" }),
        expect.objectContaining({ id: r13LegConv2, lastTurnPreview: unavailable }),
      ]));
      expect(await repo.releaseReturnedTurnIds(scope, r13LegConv1, [r13LegDelivered])).toEqual([
        { id: r13LegDelivered, role: "assistant", text: "Delivered legacy memoryOnly", citations: [] },
      ]);
      expect(await repo.releaseReturnedTurnIds(scope, r13LegConv2, [r13LegUnreleased])).toEqual([
        { id: r13LegUnreleased, role: "assistant", text: unavailable, citations: [] },
      ]);
      expect((await db.query<{ released_at: string | null }>("SELECT released_at FROM opening_help_exposures WHERE id=$1", [r13LegUnrelRec])).rows[0]?.released_at)
        .toBeNull();

      // Withdrawing r13GlobalRev redacts the already-delivered legacy memoryOnly turn too!
      await db.query("UPDATE v3_bitemporal_misconception_edges SET status='retracted' WHERE revision_id=$1", [r13GlobalRev]);
      expect((await repo.listTurns(scope, r13LegConv1)).find(t => t.id === r13LegDelivered))
        .toMatchObject({ id: r13LegDelivered, text: unavailable });
      await db.query("UPDATE v3_bitemporal_misconception_edges SET status='candidate' WHERE revision_id=$1", [r13GlobalRev]);

      // (d) P2 #4: Derived memory ("5555...") from a legacy memoryOnly turn with two confirmed backings carrying active r13GlobalLin:
      // lower UUID ("00000000-...") has an expired temporary ancestor, higher UUID ("ffffffff-...") is unexpired ->
      // first delivery succeeds and releases the receipt!
      const r13UuidConv = "b4300000-0000-4000-8000-000000000001";
      const r13UuidSrc = "b4300000-0000-4000-8000-000000000002";
      const r13LowTurn = "b4300000-0000-4000-8000-000000000003";
      const r13HighTurn = "b4300000-0000-4000-8000-000000000004";
      const r13MidLegTurn = "b4300000-0000-4000-8000-000000000005";
      const r13FinalTurn = "b4300000-0000-4000-8000-000000000006";
      const r13FinalRec = "b4300000-0000-4000-8000-000000000007";
      const r13MidLegConv = "b4300000-0000-4000-8000-000000000008";
      const r13FinalConv = "b4300000-0000-4000-8000-000000000009";
      const r13LowConf = "00000000-0000-4000-8000-000000000099";
      const r13MidDerived = "55555555-5555-4555-8555-555555555599";
      const r13HighConf = "ffffffff-ffff-4fff-8fff-ffffffffff99";
      await db.query("INSERT INTO opening_sources (id,workspace_id,version,upload_state) VALUES ($1,$2,1,'uploaded')",
        [r13UuidSrc, scope.workspaceId]);
      await db.query("INSERT INTO opening_conversations VALUES ($1,$4,$5,NULL), ($2,$4,$5,NULL), ($3,$4,$5,NULL)",
        [r13UuidConv, r13MidLegConv, r13FinalConv, scope.workspaceId, scope.ownerUserId]);
      await db.query(`INSERT INTO opening_turns (id,workspace_id,conversation_id,role,status,intent_hash,source_ids,source_versions,
          context_source_refs,query_system,created_at,text)
        VALUES ($1,$5,$6,'assistant','complete',$9,ARRAY[$10]::uuid[],jsonb_build_object($10::text,1),$11,false,to_timestamp($14),'Low backing turn with expired temp'),
               ($2,$5,$6,'assistant','complete',$9,ARRAY[$10]::uuid[],jsonb_build_object($10::text,1),$12,false,to_timestamp($14),'High backing turn clean'),
               ($3,$5,$7,'assistant','complete',NULL,'{}','{}'::jsonb,$13,false,to_timestamp($15),'Legacy memoryOnly source turn'),
               ($4,$5,$8,'assistant','complete',NULL,'{}','{}'::jsonb,$16,false,to_timestamp($17),'First delivery using derived memory')`,
        [r13LowTurn, r13HighTurn, r13MidLegTurn, r13FinalTurn, scope.workspaceId,
          r13UuidConv, r13MidLegConv, r13FinalConv,
          JSON.stringify(r13GlobalLin), r13UuidSrc,
          JSON.stringify([{ sourceId: r13UuidSrc, sourceVersion: 1 }, { memoryDependencyIds: [r13LegTempBacking] }]),
          JSON.stringify([{ sourceId: r13UuidSrc, sourceVersion: 1 }]),
          JSON.stringify([{ sourceId: r13UuidSrc, sourceVersion: 1, memoryOnly: true }]),
          baseEpochSec + 63_000, baseEpochSec + 63_010,
          JSON.stringify([{ memoryDependencyIds: [r13MidDerived] }]), baseEpochSec + 63_020]);
      await db.query(`INSERT INTO opening_memories (id,workspace_id,course_id,source_turn_ids,kind,expires_at)
        VALUES ($1,$4,NULL,$5,'confirmed',NULL),
               ($2,$4,NULL,$6,'confirmed',NULL),
               ($3,$4,NULL,$7,'confirmed',NULL)`,
        [r13LowConf, r13HighConf, r13MidDerived, scope.workspaceId,
          JSON.stringify([r13LowTurn]), JSON.stringify([r13HighTurn]), JSON.stringify([r13MidLegTurn])]);
      await db.query(`INSERT INTO opening_help_exposures (id,workspace_id,owner_user_id,course_id,turn_id,exposure_origin,release_key,context_anchor,released_at)
        VALUES ($1,$2,$3,NULL,$4,'assistant','r13-uuid-order-rec',$5,NULL)`,
        [r13FinalRec, scope.workspaceId, scope.ownerUserId, r13FinalTurn, JSON.stringify({ purpose: "learning_help" })]);
      await db.exec("ANALYZE");

      const r13UuidTurns = await repo.listTurns(scope, r13FinalConv);
      expect(r13UuidTurns.find(t => t.id === r13FinalTurn)).toMatchObject({
        id: r13FinalTurn,
        text: "First delivery using derived memory",
        exposureReceipt: expect.objectContaining({ id: r13FinalRec, releasedAt: expect.any(String) }),
      });
      expect(await repo.listSummaries(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: r13FinalConv, lastTurnPreview: "First delivery using derived memory" }),
      ]));
      expect((await db.query<{ released_at: string | null }>("SELECT released_at FROM opening_help_exposures WHERE id=$1", [r13FinalRec])).rows[0]?.released_at)
        .not.toBeNull();
    } finally {
      SqlFragment.prototype.execute = origExecute;
    }

    expect(plans.length).toBeGreaterThan(0);
  } finally {
    await db.close();
  }
}, 90_000);