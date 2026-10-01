import { randomUUID } from "node:crypto";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createOpeningLearningRepository, readOpeningCourseEvidence } from "@aistudy/database";
import { summarizeObservations } from "@aistudy/domain";
import { projectLearningSummaryResponse } from "../../apps/web/src/features/opening/learning/summary-response";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

type Row = Record<string, unknown>;
const groupCount = 10;
const now = "2026-09-30T00:00:00.000Z";
const enabled = process.env.OPENING_SUMMARY_PERF === "1";
const report = (...values: unknown[]) => process.stdout.write(`${values.map(String).join(" ")}\n`);

/** Synthetic reader workload only: distinct attempt/problem/item identities, one current source. */
async function seed(fixture: OpeningFixture, count: number): Promise<string> {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_learning_sessions, opening_learning_item_versions,
    opening_learning_history_revisions, opening_workspace_history_revisions, opening_source_versions CASCADE`;
  const f = await learningAttemptFixture(fixture), attempt = await f.start({ requirementKey: "synthetic-0" });
  const fact = await f.submit(attempt, { verdictSource: "reference_checked", referenceSourceId: f.sourceId,
    referenceCheck: { referenceSourceId: f.sourceId, method: "Synthetic answer comparison", scope: "whole_answer" } });
  const [observation] = await fixture.sql`SELECT * FROM opening_learning_observations WHERE id=${fact.id}`;
  const [attemptRow] = await fixture.sql`SELECT * FROM opening_learning_attempts WHERE id=${attempt.id}`;
  const [item] = await fixture.sql`SELECT * FROM opening_learning_item_versions WHERE id=${attempt.itemVersionId}`;
  const [problem] = await fixture.sql`SELECT * FROM opening_problem_refs WHERE problem_id=${attempt.problemId}`;
  const [session] = await fixture.sql`SELECT * FROM opening_learning_sessions WHERE id=${f.sessionId}`;
  if (!observation || !attemptRow || !item || !problem || !session) throw new Error("Synthetic prototype is incomplete");
  const sessions = Array.from({ length: groupCount }, (_, group) => ({ ...session, id: randomUUID(), skill_label: `synthetic-skill-${group}` }));
  await fixture.sql.begin(async tx => {
    await tx`DELETE FROM opening_learning_observations WHERE id=${fact.id}`;
    await tx`DELETE FROM opening_learning_attempts WHERE id=${attempt.id}`;
    await tx`DELETE FROM opening_learning_item_versions WHERE id=${attempt.itemVersionId}`;
    await tx`DELETE FROM opening_learning_sessions WHERE id=${f.sessionId}`;
    await insertRows(tx, "opening_learning_sessions", sessions);
    for (let offset = 0; offset < count; offset += 250) {
      const problems: Row[] = [], items: Row[] = [], attempts: Row[] = [], observations: Row[] = [];
      for (let index = offset; index < Math.min(count, offset + 250); index++) {
        const group = index % groupCount, selectedSession = sessions[group]!;
        const id = randomUUID(), attemptId = randomUUID(), problemId = randomUUID(), itemVersionId = randomUUID();
        const at = new Date(Date.parse("2026-09-20T00:00:00.000Z") + index * 1000).toISOString();
        const startedAt = new Date(Date.parse(at) - 60_000).toISOString();
        const outcome = Math.floor(index / groupCount) % 5 === 0 ? "incorrect" : "correct";
        const identity = { session_id: selectedSession.id, skill_label: selectedSession.skill_label, requirement_key: `synthetic-${group}` };
        problems.push({ ...problem, problem_id: problemId, session_id: selectedSession.id });
        items.push({ ...item, id: itemVersionId, problem_id: problemId });
        attempts.push({ ...attemptRow, ...identity, id: attemptId, problem_id: problemId, item_version_id: itemVersionId,
          started_at: startedAt, submitted_at: at, observation_id: id, client_key: attemptId, history_revision: index * 2 + 1,
          create_intent: { sessionId: selectedSession.id, requirementKey: identity.requirement_key, syntheticPerformanceFixture: true } });
        observations.push({ ...observation, ...identity, id, attempt_id: attemptId, problem_id: problemId, item_version_id: itemVersionId,
          answer: `Synthetic answer ${index}`, outcome, client_key: id, occurred_at: at, started_at: startedAt, submitted_at: at, recorded_at: at,
          history_revision: index * 2 + 2, workspace_history_revision: index + 1, root_observation_id: id, effective_head_id: id,
          reference_check: { ...(observation.reference_check as Row), attemptId, problemId, itemVersionId, outcome },
          submitted_intent: { attemptId, outcome, syntheticPerformanceFixture: true } });
      }
      await insertRows(tx, "opening_problem_refs", problems);
      await insertRows(tx, "opening_learning_item_versions", items);
      await insertRows(tx, "opening_learning_attempts", attempts);
      await insertRows(tx, "opening_learning_observations", observations);
    }
    await tx`UPDATE opening_learning_history_revisions SET revision=${count * 2}
      WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId} AND course_id=${f.courseId}`;
    await tx`UPDATE opening_workspace_history_revisions SET revision=${count}
      WHERE workspace_id=${fixture.scope.workspaceId} AND owner_user_id=${fixture.scope.ownerUserId}`;
  });
  return f.courseId;
}

type SeedTable = "opening_learning_sessions" | "opening_problem_refs" | "opening_learning_item_versions" | "opening_learning_attempts" | "opening_learning_observations";
async function insertRows(tx: TransactionSql, table: SeedTable, rows: Row[]) {
  await tx`INSERT INTO ${tx(table)} SELECT * FROM json_populate_recordset(NULL::${tx(table)}, ${JSON.stringify(rows)}::text::json)`;
}

function memory() {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, external, arrayBuffers };
}
function queryCategory(query: string): string {
  const statement = query.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "unknown";
  const table = /\b(?:from|join)\s+([a-z_]+)/i.exec(query)?.[1];
  return table ? `${statement}:${table}` : statement;
}
const milliseconds = (value: number) => Math.round(value * 1000) / 1000;

async function measure(sql: Sql, fixture: OpeningFixture, courseId: string, count: number, phase: string,
  queries: Map<string, number>) {
  queries.clear();
  const before = memory(), peak = { ...before }, cpuBefore = process.cpuUsage();
  const sample = () => {
    const current = memory();
    for (const key of Object.keys(peak) as Array<keyof typeof peak>) peak[key] = Math.max(peak[key], current[key]);
  };
  const sampler = setInterval(sample, 20);
  try {
    const start = performance.now();
    await createOpeningLearningRepository(sql).assertOwnedCourse(fixture.scope, courseId);
    const authorized = performance.now();
    const evidence = await readOpeningCourseEvidence(sql, fixture.scope, courseId);
    const read = performance.now(); sample();
    const summaries = summarizeObservations(evidence.observations, now, { evidenceContexts: evidence.evidenceContexts });
    const summarized = performance.now(); sample();
    const response = summaries.map(projectLearningSummaryResponse);
    const projected = performance.now(); sample();
    const serialized = JSON.stringify(response);
    const finished = performance.now(); sample();
    const after = memory(), cpu = process.cpuUsage(cpuBefore);
    expect(evidence.observations).toHaveLength(count);
    expect(response).toHaveLength(groupCount);
    expect(response.reduce((sum, row) => sum + row.sampleCount, 0)).toBe(count);
    expect(response.every(row => row.evidenceIds.length === 20)).toBe(true);
    expect(response.reduce((sum, row) => sum + (row.historicalIncorrectCount ?? 0), 0)).toBe(count / 5);
    report("OPENING_SUMMARY_PERF_SAMPLE", JSON.stringify({ phase, records: count, groups: response.length,
      milliseconds: { authorization: milliseconds(authorized - start), evidenceRead: milliseconds(read - authorized),
        summarize: milliseconds(summarized - read), project: milliseconds(projected - summarized),
        serialize: milliseconds(finished - projected), total: milliseconds(finished - start) },
      responseBytes: Buffer.byteLength(serialized, "utf8"), returnedEvidenceIds: response.reduce((sum, row) => sum + row.evidenceIds.length, 0),
      sqlQueries: [...queries.values()].reduce((sum, calls) => sum + calls, 0), sqlByCategory: Object.fromEntries(queries),
      appMemoryBytes: { before, after, sampledPeak: peak, sampleIntervalMs: 20 }, cpuMicroseconds: cpu,
    }));
  } finally { clearInterval(sampler); }
}

// Explicitly opt in and increase records one measured tier at a time; this is not a latency acceptance gate.
it.skipIf(!enabled)("measures the real course summary read with synthetic records", async () => {
  const count = Number(process.env.OPENING_SUMMARY_PERF_RECORDS ?? "1000");
  if (![1000, 10_000, 100_000].includes(count)) throw new Error("OPENING_SUMMARY_PERF_RECORDS must be 1000, 10000 or 100000");
  const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB);
  if (url.hostname !== "127.0.0.1" || url.port !== "15432") throw new Error("Performance fixture requires 127.0.0.1:15432/aistudy_opening_test");
  const fixture = await createOpeningFixture(), queries = new Map<string, number>();
  const sql = postgres(url.toString(), { max: 10, debug: (_connection, query) => {
    const category = queryCategory(query); queries.set(category, (queries.get(category) ?? 0) + 1);
  } });
  try {
    const setupStart = performance.now(), courseId = await seed(fixture, count);
    const [database] = await sql`SELECT version() AS version`;
    report("OPENING_SUMMARY_PERF_ENVIRONMENT", JSON.stringify({
      node: process.version, os: { platform: platform(), release: release(), arch: arch() },
      cpu: { model: cpus()[0]?.model, logicalCpus: cpus().length }, hostMemoryBytes: { total: totalmem(), free: freemem() },
      database: database?.version, seedMilliseconds: milliseconds(performance.now() - setupStart), records: count,
      distribution: { courses: 1, requirementSkillGroups: groupCount, recordsPerGroup: count / groupCount,
        originalHeads: count, correctedHeads: 0, retractedHeads: 0, sourceVersions: 1, helpExposures: 0,
        referenceCheckedCorrect: count * 0.8, referenceCheckedIncorrect: count * 0.2 },
      limitations: ["First read is application-first, not physical cold cache; seeding has warmed database pages",
        "Sequential warm reads, no concurrent load", "No forced GC; sampled memory can miss short synchronous peaks",
        "Database memory and container resource limits are not measured", "No HTTP transport/auth-session overhead or provider calls"],
    }));
    for (const phase of ["application-first", "warm-1", "warm-2", "warm-3"]) {
      report(`OPENING_SUMMARY_PERF_START ${phase}`);
      await measure(sql, fixture, courseId, count, phase, queries);
    }
  } finally {
    try { await sql.end({ timeout: 5 }); }
    finally {
      try {
        const workspaces = [fixture.scope.workspaceId, fixture.otherScope.workspaceId];
        const users = [fixture.scope.ownerUserId, fixture.otherScope.ownerUserId];
        await fixture.sql.begin(async tx => {
          await tx`DELETE FROM opening_learning_sessions WHERE workspace_id IN ${tx(workspaces)}`;
          await tx`DELETE FROM opening_learning_item_versions WHERE workspace_id IN ${tx(workspaces)}`;
          await tx`DELETE FROM opening_learning_history_revisions WHERE workspace_id IN ${tx(workspaces)}`;
          await tx`DELETE FROM opening_workspace_history_revisions WHERE workspace_id IN ${tx(workspaces)}`;
          await tx`DELETE FROM opening_source_versions WHERE workspace_id IN ${tx(workspaces)}`;
          await tx`DELETE FROM courses WHERE workspace_id IN ${tx(workspaces)}`;
          await tx`DELETE FROM workspaces WHERE id IN ${tx(workspaces)}`;
          await tx`DELETE FROM sessions WHERE user_id IN ${tx(users)}`;
          await tx`DELETE FROM users WHERE id IN ${tx(users)}`;
        });
      } finally { await fixture.close(); }
    }
  }
}, 180_000);



