import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";
import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";
import { loadTutorHistoryContext, readTutorHistoryAncestorStatus } from "./opening-tutor-history";
import { createOpeningMemoryRepository } from "./opening-memory";
import { admitTaskCandidate } from "./opening-task-candidate-admission";
import { sqlSimulation, unexpected } from "./opening-resident-f11-sql-simulation";
import { assertTutorAttemptContext, readTutorAttemptContext, tutorAttemptFence } from "./opening-tutor-attempt-context";
import {
  assertTutorLearnerMisconceptionSnapshot, readTutorLearnerMisconceptionContext, type TutorMisconceptionSnapshot,
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
      source_turn_id: assistantTurnId, has_memory_dependencies: true, historical_user_turn_id: null,
      source_ids: [], course_id: courseId, role: "assistant", context_source_refs: [{ memoryDependencyIds: [dependencyId] }] }];
    if (text.startsWith("SELECT id FROM courses") && text.endsWith("FOR SHARE")) {
      courseLocked = true;
      return [{ id: courseId }];
    }
    if (text.startsWith("SELECT t.id FROM opening_turns a")) return [{ id: assistantTurnId }];
    if (text.startsWith("SELECT c.id FROM opening_assistant_candidates")) {
      expect(courseLocked).toBe(true);
      expect(text).toContain("WITH RECURSIVE mem_deps(dep_id)");
      expect(text).toContain("lineage.course_id = (dm).course_id");
      expect(text).toContain("v3_bitemporal_misconception_edges");
      return active ? [{ id: candidateId }] : [];
    }
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
      expect(query.values.slice(0, 3)).toEqual([scope.workspaceId, [root], courseId]);
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
  const recent = { ...prior, assistant_intent_hash: null, question: "more recent follow-up", answer: "derived follow-up" };
  let priorRows: Array<typeof prior | typeof recent> = [recent, prior];
  let authorityActive = true;
  const checkAuthority = vi.fn(() => authorityActive ? [{ position: 0 }] : []);
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
    return checkAuthority();
  }, { json: (value: unknown) => value, unsafe: (value: string) => value }) as unknown as Sql;
  const load = () => loadTutorHistoryContext(sql, scope, userTurnId);
  expect(await load()).toMatchObject({ history: expect.arrayContaining([{ role: "assistant", text: prior.answer }]),
    historyMisconceptionLineage: JSON.parse(lineage(courseId)),
    historyCourseBindings: expect.arrayContaining([expect.objectContaining({ courseId })]) });
  const collectCourseIds = new Set<string>();
  expect(await readTutorHistoryAncestorStatus(sql, scope, userTurnId, { collectCourseIds })).toMatchObject({ valid: true });
  expect(collectCourseIds).toEqual(new Set([courseId]));
  for (const currentCourse of [null, otherCourseId]) {
    priorRows = [{ ...prior, current_course_id: currentCourse } as typeof prior];
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
  priorRows = [recent];
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
