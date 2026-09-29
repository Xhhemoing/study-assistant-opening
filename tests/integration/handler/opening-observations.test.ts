import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST as createSession } from "../../../apps/web/src/app/api/opening/learning-sessions/route";
import { POST as submitObservation } from "../../../apps/web/src/app/api/opening/observations/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie = "";
let otherCookie = "";
let workspaceId = "";
let otherWorkspaceId = "";

function req(path: string, body: unknown, auth = cookie) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { cookie: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function registerUser(label: string) {
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${label}-${randomUUID()}@example.com`, password: "password123", displayName: label }),
  }));
  const body = await response.json() as { user: { workspaceId: string } };
  return { cookie: `aistudy_session=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`, workspaceId: body.user.workspaceId };
}

async function uploaded(id: string, version = 0) {
  await sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${id}, ${workspaceId}, 'paper.pdf', 'application/pdf', 1, ${"a".repeat(64)}, ${version}, 'uploaded', 'ready')`;
  await sql`INSERT INTO opening_source_chunks (source_id, source_version, page, text) VALUES (${id}, ${version}, 1, 'snapshot')`;
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({ databaseUrl, authSecret: "opening-observation-secret-32chars!!", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
  const owner = await registerUser("owner");
  cookie = owner.cookie; workspaceId = owner.workspaceId;
  const other = await registerUser("other");
  otherCookie = other.cookie; otherWorkspaceId = other.workspaceId;
});
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await sql.end({ timeout: 5 }); });

describe("opening observation handlers", () => {
  it("rejects another workspace source and a client-only reference", async () => {
    const courseId = randomUUID();
    await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${workspaceId},'Observations',${courseId})`;
    const sourceId = randomUUID();
    const foreignId = randomUUID();
    await uploaded(sourceId);
    await sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, upload_state, parse_state)
      VALUES (${foreignId}, ${otherWorkspaceId}, 'foreign.pdf', 'application/pdf', 1, ${"b".repeat(64)}, 'uploaded', 'ready')`;
    const denied = await createSession(req("/api/opening/learning-sessions", { courseId, skillLabel: "fractions", sourceIds: [foreignId] }));
    expect(denied.status).toBe(400);
    const created = await createSession(req("/api/opening/learning-sessions", { courseId, skillLabel: "fractions", sourceIds: [sourceId] }));
    expect(created.status).toBe(201);
    const session = await created.json() as { id: string };
    const cross = await submitObservation(req("/api/opening/observations", {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [], answer: "1/2",
      outcome: "correct", assistance: "independent", clientKey: "obs-cross-01", referenceSourceId: foreignId, verdictSource: "reference_checked",
    }, otherCookie));
    expect(cross.status).toBe(404);
    const reference = await submitObservation(req("/api/opening/observations", {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId], answer: "1/2",
      outcome: "correct", assistance: "independent", clientKey: "obs-ref-0001", referenceSourceId: foreignId, verdictSource: "reference_checked",
    }));
    expect(reference.status).toBe(400);

    const unknown = await submitObservation(req("/api/opening/observations", {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "1/2", outcome: "correct", assistance: "independent", clientKey: "obs-unknown1",
      verdictSource: "unknown",
    }));
    expect(unknown.status).toBe(201);
    expect(await unknown.json()).toMatchObject({ eligibility: { verifiedCorrect: "unknown" } });

    const suggestion = await submitObservation(req("/api/opening/observations", {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "1/2", outcome: "unverified", assistance: "unknown", clientKey: "obs-model001",
      verdictSource: "model_suggestion",
    }));
    expect(suggestion.status).toBe(201);
    expect((await suggestion.json() as { verdictSource: string }).verdictSource).toBe("model_suggestion");

    const selfReport = await submitObservation(req("/api/opening/observations", {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "1/2", outcome: "correct", assistance: "independent", clientKey: "obs-self0001",
    }));
    const selfBody = await selfReport.json() as { id: string; courseId: string; verdictSource: string };
    expect(selfReport.status).toBe(201);
    expect(selfBody.verdictSource).toBe("self_report");

    const replay = await submitObservation(req("/api/opening/observations", {
      sessionId: session.id, courseId: selfBody.courseId,
      skillLabel: "fractions", sourceIds: [sourceId], answer: "1/2", outcome: "correct",
      assistance: "independent", clientKey: "obs-self0001",
    }));
    expect(replay.status).toBe(201);
    expect((await replay.json() as { id: string }).id).toBe(selfBody.id);

    const conflict = await submitObservation(req("/api/opening/observations", {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "changed", outcome: "incorrect", assistance: "independent", clientKey: "obs-self0001",
    }));
    expect(conflict.status).toBe(409);

    const revision = await submitObservation(req("/api/opening/observations", {
      sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [sourceId],
      answer: "2/4", outcome: "unverified", assistance: "unknown", clientKey: "obs-revise01",
      revisesObservationId: selfBody.id,
    }));
    expect(revision.status).toBe(409);
    const revisionBody = await revision.json() as { error?: { code?: string } };
    expect(revisionBody.error?.code).toBe("CONFLICT");

    await sql`INSERT INTO opening_help_exposures
      (id, workspace_id, session_id, problem_id, turn_id, level, delivered)
      VALUES (${randomUUID()}, ${workspaceId}, ${session.id}, NULL, ${randomUUID()}, 'revealed', TRUE)`;
    const exposed = await submitObservation(req("/api/opening/observations", {
      sessionId: session.id, courseId: selfBody.courseId, skillLabel: "fractions",
      sourceIds: [sourceId], answer: "1/2", outcome: "correct", assistance: "independent",
      clientKey: "obs-exposed1",
    }));
    expect(exposed.status).toBe(201);
    const exposedBody = await exposed.json() as { assistance: string; allowsIndependent: boolean };
    expect(exposedBody.assistance).toBe("independent");
    expect(exposedBody.allowsIndependent).toBe(false);

    const fresh = await createSession(req("/api/opening/learning-sessions", {
      courseId: selfBody.courseId, skillLabel: "fractions", sourceIds: [sourceId],
    }));
    expect(fresh.status).toBe(201);
    const freshSession = await fresh.json() as { id: string };
    const isolated = await submitObservation(req("/api/opening/observations", {
      sessionId: freshSession.id, courseId: selfBody.courseId, skillLabel: "fractions",
      sourceIds: [sourceId], answer: "1/2", outcome: "correct", assistance: "independent",
      clientKey: "obs-fresh001",
    }));
    expect(isolated.status).toBe(201);
    const isolatedBody = await isolated.json() as { assistance: string };
    expect(isolatedBody.assistance).toBe("independent");
  });
});
