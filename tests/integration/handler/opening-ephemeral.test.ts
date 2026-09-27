import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import {
  complete,
  ephemeralCounts,
  postEphemeral,
  resetEphemeralRows,
  sql,
  startEphemeralHandler,
  stopEphemeralHandler,
  workspaceForCookie,
} from "./opening-ephemeral-harness";

beforeAll(startEphemeralHandler);
beforeEach(resetEphemeralRows);
afterAll(stopEphemeralHandler);

describe("POST /api/opening/ephemeral", () => {
  it("returns a stripped reply and writes no conversation, job, candidate, memory, or learning rows", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const before = await ephemeralCounts();
    complete.mockResolvedValue({
      text: "listening",
      citedChunkIds: [],
      requestId: "req-handler",
      candidates: [{ kind: "task", title: "do homework", minutes: 15, dueText: null }],
      inputTokens: 4,
      outputTokens: 2,
    });
    const response = await POST(postEphemeral({
      text: "I am tired",
      sourceIds: [],
      mode: "listen",
      history: [{ role: "user", text: "earlier" }],
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.candidates).toEqual([]);
    expect(body.text).toBe("listening");
    expect(JSON.stringify(body)).not.toContain("do homework");
    const after = await ephemeralCounts();
    expect(after.conversations).toBe(before.conversations);
    expect(after.turns).toBe(before.turns);
    expect(after.jobs).toBe(before.jobs);
    expect(after.candidates).toBe(before.candidates);
    expect(after.memories).toBe(before.memories);
    expect(after.learning_sessions).toBe(before.learning_sessions);
    expect(after.learning_observations).toBe(before.learning_observations);
    expect(after.reservations).toBe(before.reservations + 1);
  });

  it("strips think_together model candidates and does not save a fallback", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    complete.mockResolvedValue({
      text: "together",
      citedChunkIds: [],
      requestId: null,
      candidates: [{ kind: "memory", text: "likes hints", temporary: true }],
      inputTokens: 3,
      outputTokens: 1,
    });
    const response = await POST(postEphemeral({
      text: "think", sourceIds: [], mode: "think_together", history: [],
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).candidates).toEqual([]);

    complete.mockRejectedValue(new OpeningProviderError("PROVIDER_UNAVAILABLE", "provider request failed", true));
    const failed = await POST(postEphemeral({
      text: "again", sourceIds: [], mode: "listen", history: [],
    }));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const after = await ephemeralCounts();
    expect(after.conversations).toBe(0);
    expect(after.turns).toBe(0);
    expect(after.jobs).toBe(0);
  });

  it("returns 400 for over-limit history and 404 for a foreign source", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const history = Array.from({ length: 17 }, () => ({ role: "user", text: "x" }));
    const limited = await POST(postEphemeral({
      text: "too long", sourceIds: [], mode: "listen", history,
    }));
    expect(limited.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();

    const denied = await POST(postEphemeral({
      text: "foreign", sourceIds: [randomUUID()], mode: "listen", history: [],
    }));
    expect(denied.status).toBe(404);
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const response = await POST(new Request("http://localhost/api/opening/ephemeral", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", sourceIds: [], mode: "listen", history: [] }),
    }));
    expect(response.status).toBe(401);
  });

  it("keeps an authorized citation id and drops an unauthorized one", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const workspaceId = await workspaceForCookie();
    const sourceId = randomUUID();
    const chunkId = randomUUID();
    await sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${workspaceId}, 'note.pdf', 'application/pdf', 12, ${"b".repeat(64)}, 0, 'uploaded', 'ready')
    `;
    await sql`
      INSERT INTO opening_source_chunks (id, source_id, source_version, page, text)
      VALUES (${chunkId}, ${sourceId}, 0, 1, ${"PRIVATE-QUOTE-DO-NOT-LOG"})
    `;
    complete.mockResolvedValue({
      text: "from the page",
      citedChunkIds: [chunkId, randomUUID()],
      requestId: "req-cite",
      candidates: [],
      inputTokens: 5,
      outputTokens: 2,
    });
    const response = await POST(postEphemeral({
      text: "explain this", sourceIds: [sourceId], mode: "explain", history: [],
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.citedChunkIds).toEqual([chunkId]);
    expect(JSON.stringify(body)).not.toContain("PRIVATE-QUOTE");
    expect(JSON.stringify(complete.mock.calls[0][0])).toContain("PRIVATE-QUOTE-DO-NOT-LOG");
  });

  it("aborts through the provider without creating saved conversation rows", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    complete.mockImplementation((_input: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      release();
      signal?.addEventListener("abort", () => {
        reject(new OpeningProviderError("PROVIDER_ABORTED", "provider request aborted", false));
      }, { once: true });
    }));
    const pending = POST(postEphemeral({
      text: "stop", sourceIds: [], mode: "listen", history: [],
    }, controller.signal));
    await started;
    controller.abort();
    const response = await pending;
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(499);
    expect(body.error.code).toBe("PROVIDER_ABORTED");
    expect(body.error.message).not.toMatch(/stop|PRIVATE/);
    expect(JSON.stringify(body)).not.toContain("stop");
    const after = await ephemeralCounts();
    expect(after.conversations).toBe(0);
    expect(after.turns).toBe(0);
    expect(after.jobs).toBe(0);
    expect(after.candidates).toBe(0);
    expect(after.memories).toBe(0);
    expect(after.learning_sessions).toBe(0);
  });
});
