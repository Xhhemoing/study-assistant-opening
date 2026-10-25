import { describe, expect, it, vi } from "vitest";
import { OpeningApiError, createOpeningApi, resolveUploadPutUrl, sourceDownloadHref } from "./api";

const U = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const ISO = "2026-09-13T12:00:00.000Z";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("lesson read recovery", () => {
  it.each([502, 503, 504, "network"])("recovers once from %s without a manual reload", async failure => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        if (failure === "network") throw new TypeError("Failed to fetch");
        return jsonResponse({ error: { message: "temporarily unavailable" } }, failure as number);
      })
      .mockImplementationOnce(async () => jsonResponse([]));
    const api = createOpeningApi(fetchImpl);
    await expect(api.listTeachingActivities()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]).toEqual(fetchImpl.mock.calls[0]);
  });

  it.each(["listTeachingActivities", "getTeachingActivity", "getTeachingClientInit", "getTeachingResume"] as const)(
    "%s stops after one retry and preserves the final error", async method => {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "still unavailable", code: "UNAVAILABLE" } }, 503));
      const api = createOpeningApi(fetchImpl);
      await expect(api[method](U)).rejects.toMatchObject({ status: 503, code: "UNAVAILABLE", message: "still unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each([401, 403, 404, 409, 429, 500])("does not retry HTTP %s", async status => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "action required" } }, status));
    await expect(createOpeningApi(fetchImpl).listTeachingActivities()).rejects.toMatchObject({ status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry cancellation or a malformed successful response", async () => {
    const aborted = vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); });
    await expect(createOpeningApi(aborted).listTeachingActivities()).rejects.toMatchObject({ name: "AbortError" });
    expect(aborted).toHaveBeenCalledTimes(1);
    const malformed = vi.fn(async () => jsonResponse({ activities: [] }));
    await expect(createOpeningApi(malformed).listTeachingActivities()).rejects.toThrow();
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it("does not replay a write on a transient server failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "temporarily unavailable" } }, 503));
    await expect(createOpeningApi(fetchImpl).requestTeachingCompile(U, "compile:once")).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("openingApi (RU-07 client)", () => {
  it("forwards abort signals through conversation recovery and job polling reads", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      if (url.endsWith("/resume")) return jsonResponse({ conversationId: U, courseId: null, sourceIds: [], boundedHistory: [], historyTruncated: false });
      if (url.endsWith("/turns")) return jsonResponse([]);
      return jsonResponse({ id: U, status: "running", error: null, updatedAt: ISO });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await api.resumeConversation(U, controller.signal);
    await api.listTurns(U, controller.signal);
    await api.getPendingJob(U, controller.signal);
    await api.getJob(U, controller.signal);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

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

      await expect(api.getJob(U)).rejects.toMatchObject({
        name: "OpeningResponseError",
        message: "暂时读不懂服务器返回的内容。请先刷新看看当前状态，再决定是否重试。",
        cause: { name: "ZodError", issues: [{ code: "unrecognized_keys", keys: ["extra"] }] },
      });
    });

  it("reports malformed success JSON as unverified rather than exposing parser output or returning an empty list", async () => {
    const api = createOpeningApi(async () => new Response("<html>internal upstream error</html>", { status: 200 }));
    await expect(api.listConversations()).rejects.toMatchObject({ name: "OpeningResponseError", cause: { name: "ZodError" } });
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
  const baseSource = {
    id: S,
    workspaceId: U,
    name: "lec.pdf",
    mime: "application/pdf",
    bytes: 12,
    sha256: "a".repeat(64),
    version: 0,
    uploadState: "pending" as const,
    parseState: "not_started" as const,
    error: null,
    createdAt: ISO,
  };

  it.each([
    [`https://upload.local/opening/${U}/${S}`, "upload.local stub"],
    [`https://host/s3/aistudy/staging/${S}?X-Amz-Signature=x`, "public /s3/ presign"],
    [`http://127.0.0.1:9000/aistudy/staging/${S}?X-Amz-Signature=x`, "loopback MinIO"],
    [`http://localhost:3000/api/opening/sources/${S}/staging`, "absolute staging"],
    [`https://cdn.example/__SOURCE_ID__/put`, "placeholder stub"],
  ])("always resolves %s to same-origin staging (%s)", (uploadUrl) => {
    const url = resolveUploadPutUrl({
      source: baseSource,
      uploadUrl,
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

  it("exposes a plan-accept conflict reason on OpeningApiError", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ acceptSuggestedKeys: ["planner:2026-10-15:weak_skill:x:y"] });
      return jsonResponse({ error: { code: "CONFLICT", message: "stale", reason: "stale_version" } }, 409);
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await expect(
      api.acceptPlan({
        draftId: U,
        expectedBaseVersion: 1,
        clientKey: "accept-plan-abcdefgh",
        acceptSuggestedKeys: ["planner:2026-10-15:weak_skill:x:y"],
      }),
    ).rejects.toMatchObject({ name: "OpeningApiError", status: 409, code: "CONFLICT", reason: "stale_version" });
  });

  it("keeps hasNewerSuggestion on the Today read", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ date: "2026-10-15", acceptedVersion: 0, blocks: [], hardBlocks: [], hasNewerSuggestion: true }),
    );
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await expect(api.getToday("2026-10-15")).resolves.toMatchObject({ hasNewerSuggestion: true });
    await api.getToday("2026-10-15", { refreshSuggestions: true });
    expect(fetchImpl.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "/api/opening/today?date=2026-10-15",
      "/api/opening/today?date=2026-10-15&refresh=suggestions",
    ]);
  });

  it("builds same-origin download href without MinIO hosts", () => {
    const href = sourceDownloadHref(S, 0);
    expect(href).toBe(`/api/opening/sources/${S}/download?version=0`);
    expect(href).not.toContain("127.0.0.1:9000");
    expect(href).not.toContain(":9000");
    expect(href).not.toContain("minio");
  });

  it("refreshes an upload ticket on the same source id", async () => {
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe(`/api/opening/sources/${S}/upload-ticket`);
      expect(init?.method).toBe("POST");
      return jsonResponse({
        source: baseSource,
        uploadUrl: `http://localhost:3000/api/opening/sources/${S}/staging`,
        expiresAt: ISO,
      });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const ticket = await api.refreshUploadTicket(S);
    expect(ticket.source.id).toBe(S);
    expect(ticket.uploadUrl).toContain("/staging");
    expect(ticket.uploadUrl).not.toContain("127.0.0.1:9000");
  });
});

describe("openingApi snippets and ephemeral provenance", () => {
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
    await expect(createOpeningApi(fetchImpl as unknown as typeof fetch).requestTaskReminder(input)).rejects.toMatchObject({ name: "OpeningResponseError", cause: { name: "ZodError" } });
  });
});


describe("openingApi teaching activities (CT-03)", () => {
  it("lists and creates teaching activities", async () => {
    const row = {
      id: U,
      workspaceId: U,
      ownerUserId: S,
      courseId: null,
      status: "active",
      generateStatus: "queued",
      intentKind: "topic",
      intentSummary: "今日主题学习",
      sourceIds: [],
      pathVersion: 1,
      contentVersion: 0,
      clientKey: "today-topic:2026-10-11",
      createdAt: ISO,
      updatedAt: ISO,
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/opening/teaching-activities" && (init?.method ?? "GET") === "GET") {
        return jsonResponse([row]);
      }
      if (url === "/api/opening/teaching-activities" && init?.method === "POST") {
        return jsonResponse(row, 201);
      }
      throw new Error(`unexpected ${url}`);
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const listed = await api.listTeachingActivities();
    expect(listed[0]?.intentSummary).toBe("今日主题学习");
    const created = await api.createTeachingActivity({
      clientKey: "today-topic:2026-10-11",
      intentKind: "topic",
      intentSummary: "今日主题学习",
      createIntent: { intentKind: "topic", source: "today" },
    });
    expect(created.id).toBe(U);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("requests teaching compile via POST .../compile and returns the queued activity", async () => {
    const activity = {
      id: U, workspaceId: S, ownerUserId: S, courseId: null, status: "active", generateStatus: "queued",
      intentKind: "topic", intentSummary: "今日主题学习", sourceIds: [], pathVersion: 1, contentVersion: 0,
      clientKey: "today-topic:2026-10-11", createdAt: ISO, updatedAt: ISO,
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/api/opening/teaching-activities/${U}/compile`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ clientKey: "compile:abc123" });
      return jsonResponse({ activity, jobId: "job-1" }, 202);
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await expect(api.requestTeachingCompile(U, "compile:abc123")).resolves.toMatchObject({ generateStatus: "queued" });
  });

  it("fetches teaching clientInit via GET .../client-init", async () => {
    const BID = "44444444-4444-4444-8444-444444444444";
    const DOC = "66666666-6666-4666-8666-666666666666";
    const UNIT = "77777777-7777-4777-8777-777777777777";
    const SPEC = "88888888-8888-4888-8888-888888888888";
    const init = {
      id: SPEC,
      activityId: U,
      teachingUnitId: UNIT,
      documentId: DOC,
      revisionNumber: 1,
      blockOrder: [{ blockId: BID, position: 0, blockType: "text", role: "teach" }],
      sourceRefs: [],
      goals: [],
      verificationStatus: "unchecked",
      generationConfig: {},
      version: 1,
      createdAt: ISO,
      updatedAt: ISO,
      blocks: [
        {
          blockId: BID,
          position: 0,
          blockType: "text",
          role: "teach",
          content: { text: "client init body" },
        },
      ],
      contentVersion: 1,
    };
    const fetchImpl = vi.fn(async (url: string, initReq?: RequestInit) => {
      expect(url).toBe(`/api/opening/teaching-activities/${U}/client-init`);
      expect(initReq?.method).toBe("GET");
      return jsonResponse(init);
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const body = await api.getTeachingClientInit(U);
    expect(body.blocks[0]?.content).toEqual({ text: "client init body" });
  });
});

describe("openingApi intervention settings (V2-11)", () => {
  const prefs = {
    proactivity: "balanced",
    nodes: { allowOnTeach: true, allowOnPrompt: true, allowOnLowEvidence: false },
    depth: "hint_then_offer",
    quietMode: false,
  };
  const response = {
    settings: prefs,
    courseOverride: null,
    sessionOverride: null,
    effective: prefs,
    saved: true,
    invalidStoredSettings: false,
  };

  it("GETs /api/opening/intervention-settings with optional course/activity query", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        `/api/opening/intervention-settings?courseId=${U}&activityId=${S}`,
      );
      expect(init?.method).toBe("GET");
      return jsonResponse(response);
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const body = await api.getInterventionSettings({ courseId: U, activityId: S });
    expect(body.effective.proactivity).toBe("balanced");
    expect(body.saved).toBe(true);
  });

  it("PUTs prefs globally and PUTs null to reset", async () => {
    const calls: { url: string; body: string | null | undefined }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : null });
      expect(init?.method).toBe("PUT");
      return jsonResponse(response);
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await api.putInterventionSettings(prefs as never);
    await api.putInterventionSettings(null);
    expect(calls[0]?.url).toBe("/api/opening/intervention-settings");
    expect(JSON.parse(calls[0]!.body!)).toEqual(prefs);
    expect(calls[1]?.body).toBe("null");
  });

  it("PUTs session overlay with activityId and expectedUpdatedAt", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain(`activityId=${U}`);
      expect(url).toContain(`expectedUpdatedAt=${encodeURIComponent(ISO)}`);
      expect(init?.method).toBe("PUT");
      return jsonResponse({
        ...response,
        sessionOverride: { quietMode: true },
        effective: { ...prefs, quietMode: true },
      });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const body = await api.putInterventionSettings(
      { quietMode: true },
      { activityId: U, expectedUpdatedAt: ISO },
    );
    expect(body.sessionOverride?.quietMode).toBe(true);
    expect(body.effective.quietMode).toBe(true);
  });
});

describe("openingApi teaching commands (V2-12)", () => {
  const AID = "11111111-1111-4111-8111-111111111111";
  const BID = "44444444-4444-4444-8444-444444444444";

  it("POSTs commands and parses success body", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/api/opening/teaching/activities/${AID}/commands`);
      expect(init?.method).toBe("POST");
      const payload = JSON.parse(String(init?.body));
      expect(payload.kind).toBe("why");
      expect(payload.blockId).toBe(BID);
      expect(payload.expectedVersion).toBe(1);
      expect(payload.clientKey.length).toBeGreaterThanOrEqual(8);
      return jsonResponse({
        ok: true,
        kind: "why",
        activityId: AID,
        contentVersion: 1,
        pathVersion: 1,
        checkpointJson: {},
        replayed: false,
        assist: { kind: "why", summary: "assist only" },
      });
    });
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const body = await api.postTeachingCommand(AID, {
      clientKey: "cmd-test-key-01",
      kind: "why",
      blockId: BID,
      expectedVersion: 1,
    });
    expect(body.ok).toBe(true);
    if (body.ok) {
      expect(body.assist?.summary).toBe("assist only");
      expect(body.contentVersion).toBe(1);
    }
  });

  it("treats HTTP 409 structured conflict as ok:false (never LWW throw-as-success)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          conflict: "stale_content_version",
          message: "content_version mismatch",
          currentContentVersion: 4,
          currentPathVersion: 2,
        },
        409,
      ),
    );
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    const body = await api.postTeachingCommand(AID, {
      clientKey: "cmd-test-key-02",
      kind: "rephrase",
      blockId: BID,
      expectedVersion: 1,
    });
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.conflict).toBe("stale_content_version");
      expect(body.currentContentVersion).toBe(4);
    }
  });

  it("throws OpeningApiError on non-409 failures", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "forbidden", code: "FORBIDDEN" } }, 403),
    );
    const api = createOpeningApi(fetchImpl as unknown as typeof fetch);
    await expect(
      api.postTeachingCommand(AID, {
        clientKey: "cmd-test-key-03",
        kind: "skip",
        blockId: BID,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ name: "OpeningApiError", status: 403 });
  });
});
