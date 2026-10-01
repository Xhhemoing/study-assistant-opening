import { describe, expect, it, vi } from "vitest";
import { OpeningApiError, createOpeningApi, resolveUploadPutUrl } from "./api";

const U = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const ISO = "2026-09-13T12:00:00.000Z";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("openingApi (RU-07 client)", () => {
  it("lists conversations at GET /api/opening/conversations", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/opening/conversations");
      expect(init?.method).toBe("GET");
      return jsonResponse([
        {
          id: U,
          title: "inverse",
          courseId: null,
          updatedAt: ISO,
          lastTurnPreview: "step 2",
        },
      ]);
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const rows = await api.listConversations();
    expect(rows[0]?.title).toBe("inverse");
  });

  it("resumes with ConversationResume schema", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`/api/opening/conversations/${U}/resume`);
      return jsonResponse({
        conversationId: U,
        courseId: null,
        sourceIds: [S],
        boundedHistory: [{ role: "user", text: "hi" }],
        historyTruncated: false,
      });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const resume = await api.resumeConversation(U);
    expect(resume.boundedHistory).toHaveLength(1);
    expect(resume.sourceIds).toEqual([S]);
    expect(resume.boundedHistory[0]?.citations ?? []).toEqual([]);
  });

  it("parses resume citations instead of stripping them", async () => {
    const citation = {
      chunkId: "33333333-3333-4333-8333-333333333333",
      sourceId: S,
      sourceVersion: 1,
      label: "p.2",
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        conversationId: U,
        courseId: null,
        sourceIds: [S],
        boundedHistory: [{ role: "assistant", text: "hi", citations: [citation] }],
        historyTruncated: false,
      }),
    );
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const resume = await api.resumeConversation(U);
    expect(resume.boundedHistory[0]?.citations).toEqual([citation]);
  });

  it("discovers the owner-scoped pending job for a conversation", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/api/opening/conversations/${U}/pending-job`);
      expect(init?.method).toBe("GET");
      return jsonResponse({ id: U, status: "queued", error: null, updatedAt: ISO });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);

    await expect(api.getPendingJob(U)).resolves.toEqual({
      id: U,
      status: "queued",
      error: null,
      updatedAt: ISO,
    });
  });

  it("returns no pending job when the conversation has none", async () => {
    const api = createOpeningApi(vi.fn(async () => jsonResponse(null)) as unknown as typeof fetch);
    await expect(api.getPendingJob(U)).resolves.toBeNull();
  });

  it.each(["queued", "running", "succeeded", "failed", "cancelled", "outcome_unknown"] as const)(
    "gets strict job status response for %s",
    async (status) => {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(`/api/opening/jobs/${U}`);
        expect(init?.method).toBe("GET");
        return jsonResponse({
          id: U,
          status,
          error: status === "failed" ? { message: "provider rejected" } : null,
          updatedAt: ISO,
        });
      });
      const api = createOpeningApi(fetchImpl as unknown as typeof fetch);

      await expect(api.getJob(U)).resolves.toEqual({
        id: U,
        status,
        error: status === "failed" ? { message: "provider rejected" } : null,
        updatedAt: ISO,
      });
    },
  );

  it("rejects job status responses with unknown fields", async () =>
    {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ id: U, status: "queued", error: null, updatedAt: ISO, extra: true }),
      );
      const api = createOpeningApi(fetchImpl as unknown as typeof fetch);

      await expect(api.getJob(U)).rejects.toThrow();
    });

  it("posts ephemeral turns with the caller AbortSignal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/opening/ephemeral");
      expect(init?.signal).toBe(controller.signal);
      expect(JSON.parse(String(init?.body))).toMatchObject({ historyPrivacyEpoch: 2 });
      return jsonResponse({
        text: "temporary answer",
        citedChunkIds: [],
        requestId: "ephemeral-request",
        privacyEpoch: 2,
        historyDiscarded: true,
        candidates: [],
        inputTokens: null,
        outputTokens: null,
      });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await expect(api.replyEphemeral({
      text: "q", sourceIds: [], mode: "listen", history: [], historyPrivacyEpoch: 2,
    }, controller.signal)).resolves.toMatchObject({ text: "temporary answer", privacyEpoch: 2, historyDiscarded: true });
  });

  it("cancels a durable job through DELETE without inventing a result", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/api/opening/jobs/${U}`);
      expect(init?.method).toBe("DELETE");
      return jsonResponse({ id: U, status: "cancelled", error: { message: "cancelled by user" }, updatedAt: ISO });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await expect(api.cancelJob(U)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("submits saved turn to POST /api/opening/turns", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/opening/turns");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.privacy).toBe("saved");
      expect(body.conversationId).toBe(U);
      return jsonResponse({
        jobId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
      });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const out = await api.submitTurn({
      conversationId: U,
      text: "what is on this page?",
      sourceIds: [S],
      mode: "explain",
      clientKey: "client-key-abcdefgh",
      privacy: "saved",
      currentPage: 2,
    });
    expect(out.jobId).toMatch(/^3333/);
  });

  it("lists sources for material picker", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("/api/opening/sources");
      return jsonResponse([
        {
          id: S,
          workspaceId: U,
          name: "lec.pdf",
          mime: "application/pdf",
          bytes: 12,
          sha256: "a".repeat(64),
          version: 0,
          uploadState: "uploaded",
          parseState: "ready",
          error: null,
          createdAt: ISO,
        },
      ]);
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const sources = await api.listSources();
    expect(sources[0]?.uploadState).toBe("uploaded");
  });
});

describe("openingApi integration helpers", () => {
  it("routes upload.local tickets to staging PUT", () => {
    const url = resolveUploadPutUrl({
      source: {
        id: S,
        workspaceId: U,
        name: "lec.pdf",
        mime: "application/pdf",
        bytes: 12,
        sha256: "a".repeat(64),
        version: 0,
        uploadState: "pending",
        parseState: "not_started",
        error: null,
        createdAt: ISO,
      },
      uploadUrl: `https://upload.local/opening/${U}/${S}`,
      expiresAt: ISO,
    });
    expect(url).toBe(`/api/opening/sources/${S}/staging`);
  });

  it("surfaces page_not_in_sources as OpeningApiError code 422", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: "page_not_in_sources", message: "page_not_in_sources" } },
        422,
      ),
    );
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await expect(
      api.submitTurn({
        conversationId: U,
        text: "q",
        sourceIds: [S],
        mode: "explain",
        clientKey: "client-key-abcdefgh",
        privacy: "saved",
        currentPage: 3,
      }),
    ).rejects.toMatchObject({
      name: "OpeningApiError",
      status: 422,
      code: "page_not_in_sources",
    } satisfies Partial<OpeningApiError>);
  });
});

  it("passes through absolute staging uploadUrl", () => {
    const url = resolveUploadPutUrl({
      source: {
        id: S,
        workspaceId: U,
        name: "lec.pdf",
        mime: "application/pdf",
        bytes: 12,
        sha256: "a".repeat(64),
        version: 0,
        uploadState: "pending",
        parseState: "not_started",
        error: null,
        createdAt: ISO,
      },
      uploadUrl: `http://localhost:3000/api/opening/sources/${S}/staging`,
      expiresAt: ISO,
    });
    expect(url).toBe(`http://localhost:3000/api/opening/sources/${S}/staging`);
  });

  it("requests the cited source version download", async () => {
    const fetchImpl = vi.fn(async (path: string) => {
      expect(path).toBe(`/api/opening/sources/${S}/download?version=0`);
      return jsonResponse({
        url: "https://minio.local/signed",
        expiresAt: ISO,
        version: 0,
        currentVersion: 2,
        versionMismatch: true,
      });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await expect(api.getSourceDownload(S, 0)).resolves.toMatchObject({
      version: 0,
      currentVersion: 2,
      versionMismatch: true,
    });
  });


it("posts only the explicitly selected snippet and server provenance", async () => {
  const requests: Array<{ url: string; method: string | undefined; payload: unknown }> = [];
  const api = createOpeningApi((async (url, init) => {
    requests.push({ url: String(url), method: init?.method, payload: JSON.parse(String(init?.body)) });
    return jsonResponse({ documentId: U });
  }) as typeof fetch);
  await expect(api.createSnippet({ title: "我的笔记", text: "仅保存这一句", provenanceId: S })).resolves.toEqual({ documentId: U });
  expect(requests).toEqual([{ url: "/api/opening/snippets", method: "POST", payload: {
    title: "我的笔记", text: "仅保存这一句", provenanceId: S,
  } }]);
});

it("rejects invalid snippet input before making a persistence request", async () => {
  const fetchImpl = vi.fn();
  const api = createOpeningApi(fetchImpl);
  await expect(api.createSnippet({ title: "笔记", text: "x".repeat(20_001), provenanceId: S })).rejects.toThrow();
  await expect(api.createSnippet({ title: "笔记", text: "片段", provenanceId: "unknown" })).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("does not turn a malformed saved-note response into a successful save", async () => {
  const api = createOpeningApi((async () => jsonResponse({ documentId: "bad-id" })) as typeof fetch);
  await expect(api.createSnippet({ title: "笔记", text: "片段", provenanceId: S })).rejects.toThrow();
});

it("preserves the separate provenance of each temporary history message", async () => {
  let received: unknown;
  const api = createOpeningApi((async (_url, init) => {
    received = JSON.parse(String(init?.body));
    return jsonResponse({ text: "next answer", citedChunkIds: [], requestId: "next-request", privacyEpoch: 2,
      historyDiscarded: false, candidates: [], inputTokens: null, outputTokens: null, provenanceId: U });
  }) as typeof fetch);
  const result = await api.replyEphemeral({ text: "current question", sourceIds: [], mode: "listen", historyPrivacyEpoch: 2,
    history: [{ role: "user", text: "old question", provenanceId: S }, { role: "assistant", text: "old answer", provenanceId: S }],
  });
  expect(received).toMatchObject({ history: [
    { role: "user", text: "old question", provenanceId: S },
    { role: "assistant", text: "old answer", provenanceId: S },
  ] });
  expect(result.provenanceId).toBe(U);
});

it("leaves legacy temporary responses without provenance unavailable for saving", async () => {
  const api = createOpeningApi((async () => jsonResponse({ text: "legacy answer", citedChunkIds: [], requestId: "old-request",
    privacyEpoch: 2, historyDiscarded: false, candidates: [], inputTokens: null, outputTokens: null,
  })) as typeof fetch);
  const result = await api.replyEphemeral({ text: "question", sourceIds: [], mode: "listen", history: [] });
  expect(result.provenanceId).toBeNull();
});

describe("single task reminders", () => {
  const reminder = { id: S, taskId: U, taskVersion: 3, dueAt: ISO, channel: "in_app", status: "due", receiptId: null, outcome: null };
  const input = { taskId: U, expectedVersion: 3, clientKey: "single-reminder-1" };
  it("keeps the server task version needed for an explicit reminder", async () => {
    const api = createOpeningApi(vi.fn(async () => jsonResponse({ tasks: [{ id: U, title: "Review", minutes: 15, dueAt: ISO, priority: 1, status: "pending", version: 3 }] })) as unknown as typeof fetch);
    expect((await api.listTasks()).tasks[0]).toMatchObject({ version: 3 });
  });
  it.each([201, 200])("posts only one task intent and parses the %s response", async status => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ reminders: [reminder] }, status));
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await expect(api.requestTaskReminder(input)).resolves.toEqual({ reminders: [reminder] });
    expect(fetchImpl).toHaveBeenCalledWith("/api/opening/reminders", expect.objectContaining({ method: "POST", body: JSON.stringify({ clientKey: input.clientKey, channel: "in_app", taskId: U, expectedVersion: 3 }) }));
  });
  it.each([404, 409, 422])("preserves a definitive %s error without retrying", async status => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: "CONFLICT", message: "task changed" } }, status));
    await expect(createOpeningApi(fetchImpl as unknown as typeof fetch).requestTaskReminder(input)).rejects.toMatchObject({ status, code: "CONFLICT", message: "task changed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects an invalid single-task target before a write", async () => {
    const fetchImpl = vi.fn();
    await expect(createOpeningApi(fetchImpl).requestTaskReminder({ ...input, expectedVersion: 0 })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{ reminders: [] }, { reminders: [{ ...reminder, taskId: S }] }, { reminders: [{ ...reminder, taskVersion: 4 }] }])("does not report another or missing task reminder as this request's success", async ({ reminders }) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ reminders }));
    await expect(createOpeningApi(fetchImpl as unknown as typeof fetch).requestTaskReminder(input)).rejects.toMatchObject({ name: "ZodError" });
  });
});
