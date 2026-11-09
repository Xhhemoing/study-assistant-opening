import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOpeningLearningRepository, createOpeningConversationRepository,
  type OpeningLearningRepository, lockWorkspaceLearningHistory,
} from "@aistudy/database";
import { observationInputSchema } from "@aistudy/contracts";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import type { TransactionSql } from "postgres";
import { openRaceSession } from "./opening-race-helpers";
import { assertHistoryWait, observeTransaction, signal } from "./outer-caller-history-fixture";

async function uploaded(fixture: OpeningFixture, id: string, version = 1) {
  await fixture.sql`INSERT INTO opening_sources
    (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${id}, ${fixture.scope.workspaceId}, 'paper.pdf', 'application/pdf', 1,
      ${id.replace(/-/g, "").padEnd(64, "a").slice(0, 64)}, ${version}, 'uploaded', 'ready')`;
  await fixture.sql`INSERT INTO opening_source_chunks (source_id, source_version, page, text)
    VALUES (${id}, ${version}, 1, 'snapshot')`;
}

describe("ObservationInput contract (L01)", () => {
  it("requires sessionId", () => {
    expect(() =>
      observationInputSchema.parse({
        courseId: randomUUID(),
        skillLabel: "algebra",
        sourceIds: [],
        answer: "42",
        outcome: "correct",
        assistance: "independent",
        clientKey: "client-key-1",
      }),
    ).toThrow();
  });
});

describe("opening learning observations (L01)", () => {
  let fixture: OpeningFixture;
  let learning: OpeningLearningRepository;
  const courseId = randomUUID();

  beforeAll(async () => {
    fixture = await createOpeningFixture();
    learning = createOpeningLearningRepository(fixture.sql);
    await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${fixture.scope.workspaceId},'Learning',${courseId})`;
  });

  beforeEach(async () => {
    await fixture.sql`TRUNCATE opening_learning_observations, opening_help_exposures, opening_problem_refs, opening_learning_sessions, opening_source_chunks, opening_sources RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await fixture.close();
  });

  const history = () => fixture.sql`SELECT owner_user_id,revision FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;

  it.each(["lazy", "nonzero", "other-workspace"])("root createSession history barrier %s keeps revision and source snapshot", async mode => {
    const sourceId = randomUUID(); await uploaded(fixture, sourceId);
    await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
    const snapshot = { nodes: [{ id: randomUUID(), label: "Existing source concept" }], edges: [] };
    await fixture.sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
      VALUES(${fixture.scope.workspaceId},${fixture.scope.ownerUserId},${courseId},1,${fixture.sql.json(snapshot)},${fixture.sql.json({ [sourceId]: 1 })})
      ON CONFLICT(workspace_id,course_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,source_versions=EXCLUDED.source_versions`;
    if (mode !== "lazy") {
      await fixture.sql.begin(tx => lockWorkspaceLearningHistory(tx, fixture.scope));
      await fixture.sql`UPDATE opening_workspace_history_revisions SET revision=19 WHERE workspace_id=${fixture.scope.workspaceId}`;
    }
    const holder = openRaceSession(), writer = openRaceSession(), held = signal(), release = signal();
    let holderTx!: TransactionSql;
    let holding: Promise<unknown> | undefined, writing: Promise<unknown> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready]);
      holding = holder.sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, mode === "other-workspace" ? fixture.otherScope : fixture.scope);
        holderTx = tx; held.resolve(); await release.ready;
      });
      holding.catch(held.resolve); await Promise.race([held.ready, holding]);
      let finished = false;
      writing = createOpeningLearningRepository(writer.sql).createSession(fixture.scope, { courseId, skillLabel: "root barrier", sourceIds: [sourceId] });
      writing.then(() => { finished = true; }, () => { finished = true; });
      if (mode !== "other-workspace") {
        await assertHistoryWait(fixture.sql, writer.pid, holder.pid, () => finished);
        await holderTx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE NOWAIT`;
        await holderTx`SELECT id FROM courses WHERE id=${courseId} FOR UPDATE NOWAIT`;
        await holderTx`SELECT id FROM opening_sources WHERE id=${sourceId} FOR UPDATE NOWAIT`;
        await holderTx`SELECT id FROM opening_teaching_activities WHERE course_id=${courseId} FOR UPDATE NOWAIT`;
        expect(await fixture.sql`SELECT id FROM opening_learning_sessions WHERE skill_label='root barrier'`).toHaveLength(0);
        expect(await fixture.sql`SELECT source_id FROM opening_source_versions WHERE source_id=${sourceId}`).toHaveLength(0);
        release.resolve(); await holding;
      }
      await expect(writing).resolves.toMatchObject({ id: expect.any(String) });
      expect(await fixture.sql`SELECT source_id,version FROM opening_source_versions WHERE source_id=${sourceId}`).toEqual([{ source_id: sourceId, version: 1 }]);
      expect(await fixture.sql`SELECT snapshot FROM opening_course_knowledge WHERE course_id=${courseId}`).toEqual([{ snapshot }]);
      expect(await history()).toEqual([{ owner_user_id: fixture.scope.ownerUserId, revision: mode === "lazy" ? "0" : "19" }]);
    } finally {
      release.resolve(); await Promise.allSettled([holding, writing].filter(Boolean));
      await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
    }
  });

  it("root createSession rolls back session/source-version/lazy history on real SQL failure", async () => {
    const sourceId = randomUUID(); await uploaded(fixture, sourceId);
    await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
    let inserted = false;
    const client = observeTransaction(fixture.sql, async (query, tx) => {
      if (query.startsWith("INSERT INTO opening_learning_sessions")) {
        inserted = true;
        expect(await tx`SELECT id FROM opening_learning_sessions WHERE skill_label='rollback root'`).toHaveLength(1);
        expect(await tx`SELECT source_id FROM opening_source_versions WHERE source_id=${sourceId}`).toHaveLength(1);
        await tx`SELECT 1/0`;
      }
    });
    await expect(createOpeningLearningRepository(client).createSession(fixture.scope, { courseId, skillLabel: "rollback root", sourceIds: [sourceId] }))
      .rejects.toMatchObject({ code: "22012" });
    expect(inserted).toBe(true);
    expect(await fixture.sql`SELECT id FROM opening_learning_sessions WHERE skill_label='rollback root'`).toHaveLength(0);
    expect(await fixture.sql`SELECT source_id FROM opening_source_versions WHERE source_id=${sourceId}`).toHaveLength(0);
    expect(await history()).toEqual([]);
  });

  it("root createSession retains owner/course/source/activity/SQL error priority before history", async () => {
    await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
    const input = { courseId, skillLabel: "invalid root", sourceIds: [] as string[] };
    await expect(learning.createSession({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, { ...input, courseId: "bad-uuid" }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "workspace not found" });
    await expect(learning.createSession(fixture.scope, { ...input, courseId: "bad-uuid" })).rejects.toMatchObject({ code: "22P02" });
    await expect(learning.createSession(fixture.scope, { ...input, courseId: randomUUID(), sourceIds: [randomUUID()] }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "course not found" });
    await expect(learning.createSession(fixture.scope, { ...input, sourceIds: [randomUUID()], activityId: randomUUID() }))
      .rejects.toMatchObject({ code: "VALIDATION", message: "source unavailable or privacy-excluded" });
    await expect(learning.createSession(fixture.scope, { ...input, activityId: randomUUID() }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "teaching activity not found" });
    expect(await history()).toEqual([]);
  });

  it("root createSession rechecks course after history and safely rejects archive drift", async () => {
    await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
    let changed = false;
    const client = observeTransaction(fixture.sql, async query => {
      if (!changed && query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) {
        changed = true;
        await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
      }
    });
    try {
      await expect(createOpeningLearningRepository(client).createSession(fixture.scope, { courseId, skillLabel: "drift root", sourceIds: [] }))
        .rejects.toMatchObject({ code: "NOT_FOUND", message: "course not found" });
      expect(changed).toBe(true);
      expect(await history()).toEqual([]);
      expect(await fixture.sql`SELECT id FROM opening_learning_sessions WHERE skill_label='drift root'`).toHaveLength(0);
    } finally { await fixture.sql`UPDATE courses SET archived_at=NULL WHERE id=${courseId}`; }
  });

  it("root createSession preserves stale job precedence over malformed course without history", async () => {
    await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
    const scope = { ...fixture.scope, jobExecution: { id: "bad-job-uuid", token: randomUUID(), privacyEpoch: -1 } };
    await expect(learning.createSession(scope, { courseId: "bad-course-uuid", skillLabel: "stale root", sourceIds: [] }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "job execution is no longer current" });
    expect(await history()).toEqual([]);
  });

  it("root createSession keeps explicit activity validation and does not advance revision", async () => {
    const sourceId = randomUUID(); await uploaded(fixture, sourceId);
    const legacy = await learning.createSession(fixture.scope, { courseId, skillLabel: "legacy root", sourceIds: [sourceId] });
    const [session] = await fixture.sql`SELECT activity_id FROM opening_learning_sessions WHERE id=${legacy.id}`;
    const activityId = String(session!.activity_id);
    const before = await history();
    await expect(learning.createSession(fixture.scope, { courseId, activityId, skillLabel: "outside root", sourceIds: [sourceId] }))
      .rejects.toMatchObject({ code: "VALIDATION", message: "learning session source is outside teaching activity" });
    await expect(learning.createSession(fixture.scope, { courseId, activityId, skillLabel: "explicit root", sourceIds: [] }))
      .resolves.toMatchObject({ id: expect.any(String) });
    await fixture.sql`UPDATE opening_teaching_activities SET status='completed' WHERE id=${activityId}`;
    try {
      await expect(learning.createSession(fixture.scope, { courseId, activityId, skillLabel: "completed root", sourceIds: [] }))
        .rejects.toMatchObject({ code: "CONFLICT", message: "completed teaching activity cannot accept new attempts" });
      expect(await history()).toEqual(before);
    } finally { await fixture.sql`UPDATE opening_teaching_activities SET status='active' WHERE id=${activityId}`; }
  });

  it("root createSession passes through real 55P03 and rolls back lazy history", async () => {
    await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
    const blocker = openRaceSession(), held = signal(), release = signal();
    let holding: Promise<unknown> | undefined;
    try {
      await blocker.ready;
      holding = blocker.sql.begin(async tx => {
        await tx`SELECT id FROM courses WHERE id=${courseId} FOR UPDATE`;
        held.resolve(); await release.ready;
      });
      holding.catch(held.resolve); await Promise.race([held.ready, holding]);
      const client = observeTransaction(fixture.sql, async (query, tx) => {
        if (query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) {
          await tx`SELECT id FROM courses WHERE id=${courseId} FOR SHARE NOWAIT`;
        }
      });
      await expect(createOpeningLearningRepository(client).createSession(fixture.scope, { courseId, skillLabel: "locked root", sourceIds: [] }))
        .rejects.toMatchObject({ code: "55P03" });
      expect(await history()).toEqual([]);
      expect(await fixture.sql`SELECT id FROM opening_learning_sessions WHERE skill_label='locked root'`).toHaveLength(0);
    } finally { release.resolve(); await holding; await blocker.sql.end({ timeout: 5 }); }
  });

  it("preserves reported assistance without granting unknown historical independence", async () => {
    const sourceId = randomUUID();
    await uploaded(fixture, sourceId);
    const sessionA = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "fractions", sourceIds: [sourceId],
    });
    const sessionB = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "fractions", sourceIds: [sourceId],
    });
    const conversation = await createOpeningConversationRepository(fixture.sql).create(fixture.scope, { title: "Help", courseId });
    const turnId = randomUUID();
    await fixture.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,learning_session_id)
      VALUES (${turnId},${fixture.scope.workspaceId},${conversation.id},'assistant','hint','hint','complete',${sessionA.id})`;
    await learning.insertHelpExposure(fixture.scope, {
      id: randomUUID(), sessionId: sessionA.id, problemId: null,
      turnId, kind: "hint", level: "hinted", delivered: true,
    });

    const spoofed = await learning.insertObservation(fixture.scope, {
      sessionId: sessionA.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "1/2", outcome: "correct", assistance: "independent", clientKey: "obs-spoof-1xx",
    }, { verdictSource: "self_report" });
    expect(spoofed.assistance).toBe("independent");
    expect(spoofed.verdictSource).toBe("self_report");
    expect(spoofed.allowsIndependent).toBe(false);

    const retest = await learning.insertObservation(fixture.scope, {
      sessionId: sessionB.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "1/2", outcome: "correct", assistance: "independent", clientKey: "obs-retest-1x",
      problemId: randomUUID(),
    }, { verdictSource: "reference_checked", referenceSourceId: sourceId });
    expect(retest.assistance).toBe("independent");
    expect(retest.verdictSource).toBe("self_report");
    expect(retest.allowsIndependent).toBe(false);
  });

  it("rejects a reference source that is not an uploaded session snapshot", async () => {
    const sourceId = randomUUID();
    await uploaded(fixture, sourceId);
    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "fractions", sourceIds: [sourceId],
    });
    await expect(learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "1/2", outcome: "correct", assistance: "independent", clientKey: "obs-bad-ref1",
    }, { verdictSource: "reference_checked", referenceSourceId: randomUUID() })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("rejects missing or mismatched retest activity identities before saving an observation", async () => {
    const sourceId = randomUUID();
    await uploaded(fixture, sourceId);
    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "fractions", sourceIds: [sourceId],
    });
    const activityId = randomUUID();
    await fixture.sql`INSERT INTO opening_retest_activities (
      id, workspace_id, owner_user_id, course_id, skill_label, evidence_cycle_id, status, version
    ) VALUES (
      ${activityId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${courseId}, 'algebra', ${randomUUID()}, 'accepted', 2
    )`;
    await expect(learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      retestId: activityId, answer: "1", outcome: "correct", assistance: "independent", clientKey: "obs-retest-mismatch",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      retestId: randomUUID(), answer: "1", outcome: "correct", assistance: "independent", clientKey: "obs-retest-missing",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE client_key IN ('obs-retest-mismatch', 'obs-retest-missing')`).toHaveLength(0);
  });

  it("stores the canonical activity identity when a legacy candidate id is submitted", async () => {
    const sourceId = randomUUID(), candidateId = randomUUID(), activityId = randomUUID();
    await uploaded(fixture, sourceId);
    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "fractions", sourceIds: [sourceId],
    });
    await fixture.sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state)
      VALUES (${candidateId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${`retest:${candidateId}`}, 'retest', '{}'::jsonb, 'succeeded')`;
    await fixture.sql`INSERT INTO opening_retest_activities (
      id, workspace_id, owner_user_id, course_id, skill_label, evidence_cycle_id, candidate_id, status, version
    ) VALUES (
      ${activityId}, ${fixture.scope.workspaceId}, ${fixture.scope.ownerUserId}, ${courseId}, 'fractions', ${randomUUID()}, ${candidateId}, 'accepted', 2
    )`;
    await learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      retestId: candidateId, answer: "1", outcome: "unverified", assistance: "independent", clientKey: "obs-retest-canonical",
    });
    expect(await fixture.sql`SELECT retest_id FROM opening_learning_observations WHERE client_key='obs-retest-canonical'`)
      .toMatchObject([{ retest_id: activityId }]);
  });

  it("distinguishes verdictSource kinds and replays clientKey", async () => {
    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "geometry", sourceIds: [],
    });
    const first = await learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [],
      answer: "90", outcome: "unverified", assistance: "unknown", clientKey: "obs-replay-key",
    }, { verdictSource: "model_suggestion" });
    expect(first.verdictSource).toBe("model_suggestion");

    const replay = await learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [],
      answer: "90", outcome: "unverified", assistance: "unknown", clientKey: "obs-replay-key",
    }, { verdictSource: "model_suggestion" });
    expect(replay.id).toBe(first.id);
    expect(replay.verdictSource).toBe("model_suggestion");

    await expect(learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [],
      answer: "changed", outcome: "correct", assistance: "independent", clientKey: "obs-replay-key",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    const unknown = await learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [], answer: "90", outcome: "correct",
      assistance: "unknown", clientKey: "obs-unknown01", verdictSource: "unknown",
    });
    expect(unknown.outcome).toBe("correct");
    expect(unknown.eligibility.verifiedCorrect).toBe("unknown");
  });

  it("does not insert a revision until a parent column or table exists", async () => {
    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "geometry", sourceIds: [],
    });
    const parent = await learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [],
      answer: "90", outcome: "unverified", assistance: "unknown", clientKey: "obs-parent01",
    });
    await expect(learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [],
      answer: "45", outcome: "unverified", assistance: "unknown", clientKey: "obs-child001",
      revisesObservationId: parent.id,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await fixture.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM opening_learning_observations WHERE session_id = ${session.id}`;
    expect(rows[0]?.count).toBe("1");
  });

  it("isolates observations across workspaces", async () => {
    const session = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "cross", sourceIds: [],
    });
    await expect(learning.insertObservation(fixture.otherScope, {
      sessionId: session.id, courseId, skillLabel: "cross", sourceIds: [],
      answer: "x", outcome: "incorrect", assistance: "independent", clientKey: "obs-cross-ws1",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
