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
    await fixture.sql`TRUNCATE opening_learning_observations, opening_help_exposures, opening_problem_refs, opening_learning_sessions RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("session exposure overrides client independent; new session does not inherit", async () => {
    const sessionA = await learning.createSession(fixture.scope, {
      courseId,
      skillLabel: "fractions",
      sourceIds: [],
    });
    const sessionB = await learning.createSession(fixture.scope, {
      courseId,
      skillLabel: "fractions",
      sourceIds: [],
    });
    await learning.insertHelpExposure(fixture.scope, {
      id: randomUUID(),
      sessionId: sessionA.id,
      problemId: null,
      turnId: randomUUID(),
      level: "hinted",
      delivered: true,
    });

    const spoofed = await learning.insertObservation(
      fixture.scope,
      {
        sessionId: sessionA.id,
        courseId,
        skillLabel: "fractions",
        sourceIds: [],
        answer: "1/2",
        outcome: "correct",
        assistance: "independent",
        clientKey: "obs-spoof-1xx",
      },
      { verdictSource: "self_report" },
    );
    expect(spoofed.assistance).toBe("hinted");
    expect(spoofed.verdictSource).toBe("self_report");
    expect(spoofed.allowsIndependent).toBe(false);

    const retest = await learning.insertObservation(
      fixture.scope,
      {
        sessionId: sessionB.id,
        courseId,
        skillLabel: "fractions",
        sourceIds: [],
        answer: "1/2",
        outcome: "correct",
        assistance: "independent",
        clientKey: "obs-retest-1x",
        problemId: randomUUID(),
      },
      { verdictSource: "reference_checked", referenceSourceId: randomUUID() },
    );
    expect(retest.assistance).toBe("independent");
    expect(retest.verdictSource).toBe("reference_checked");
    expect(retest.allowsIndependent).toBe(true);
  });

  it("distinguishes verdictSource kinds and replays clientKey", async () => {
    const session = await learning.createSession(fixture.scope, {
      courseId,
      skillLabel: "geometry",
      sourceIds: [],
    });
    const first = await learning.insertObservation(
      fixture.scope,
      {
        sessionId: session.id,
        courseId,
        skillLabel: "geometry",
        sourceIds: [],
        answer: "90",
        outcome: "unverified",
        assistance: "unknown",
        clientKey: "obs-replay-key",
      },
      { verdictSource: "model_suggestion" },
    );
    expect(first.verdictSource).toBe("model_suggestion");

    const replay = await learning.insertObservation(
      fixture.scope,
      {
        sessionId: session.id,
        courseId,
        skillLabel: "geometry",
        sourceIds: [],
        answer: "changed",
        outcome: "correct",
        assistance: "independent",
        clientKey: "obs-replay-key",
      },
      { verdictSource: "self_report" },
    );
    expect(replay.id).toBe(first.id);
    expect(replay.answer).toBe("90");
    expect(replay.verdictSource).toBe("model_suggestion");
  });

  it("isolates observations across workspaces", async () => {
    const session = await learning.createSession(fixture.scope, {
      courseId,
      skillLabel: "cross",
      sourceIds: [],
    });
    await expect(
      learning.insertObservation(fixture.otherScope, {
        sessionId: session.id,
        courseId,
        skillLabel: "cross",
        sourceIds: [],
        answer: "x",
        outcome: "incorrect",
        assistance: "independent",
        clientKey: "obs-cross-ws1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
