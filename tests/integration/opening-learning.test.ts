import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOpeningLearningRepository,
  type OpeningLearningRepository,
} from "@aistudy/database";
import { observationInputSchema } from "@aistudy/contracts";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

function learningDbFromSql(sql: OpeningFixture["sql"]) {
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
    async execute(text: string, params: unknown[] = []): Promise<void> {
      await sql.unsafe(text, params as never[]);
    },
  };
}

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
    learning = createOpeningLearningRepository(learningDbFromSql(fixture.sql));
  });

  beforeEach(async () => {
    await fixture.sql`TRUNCATE opening_learning_observations, opening_help_exposures, opening_problem_refs, opening_learning_sessions, opening_source_chunks, opening_sources RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("session exposure overrides client independent; new session does not inherit", async () => {
    const sourceId = randomUUID();
    await uploaded(fixture, sourceId);
    const sessionA = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "fractions", sourceIds: [sourceId],
    });
    const sessionB = await learning.createSession(fixture.scope, {
      courseId, skillLabel: "fractions", sourceIds: [sourceId],
    });
    await learning.insertHelpExposure(fixture.scope, {
      id: randomUUID(), sessionId: sessionA.id, problemId: null,
      turnId: randomUUID(), level: "hinted", delivered: true,
    });

    const spoofed = await learning.insertObservation(fixture.scope, {
      sessionId: sessionA.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "1/2", outcome: "correct", assistance: "independent", clientKey: "obs-spoof-1xx",
    }, { verdictSource: "self_report" });
    expect(spoofed.assistance).toBe("hinted");
    expect(spoofed.verdictSource).toBe("self_report");
    expect(spoofed.allowsIndependent).toBe(false);

    const retest = await learning.insertObservation(fixture.scope, {
      sessionId: sessionB.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "1/2", outcome: "correct", assistance: "independent", clientKey: "obs-retest-1x",
      problemId: randomUUID(),
    }, { verdictSource: "reference_checked", referenceSourceId: sourceId });
    expect(retest.assistance).toBe("independent");
    expect(retest.verdictSource).toBe("reference_checked");
    expect(retest.allowsIndependent).toBe(true);
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
    await expect(learning.insertObservation(fixture.scope, {
      sessionId: session.id, courseId, skillLabel: "geometry", sourceIds: [],
      answer: "90", outcome: "correct", assistance: "unknown", clientKey: "obs-unknown01",
    }, { verdictSource: "unknown" })).rejects.toMatchObject({ code: "VALIDATION" });
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
