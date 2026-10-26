import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningApi, OpeningApiError } from "../opening/client/api";
import { createOpeningLearningClient } from "../opening/client/learning-client";
import { createOpeningCardsClient } from "../opening/cards/cards-client";
import { createCourseStateClient } from "../opening/courses/course-state-client";
import { createSourceActionsClient } from "../opening/inbox/source-actions-client";
import { createMeasurementClient } from "../opening/measurement/client";
import { clearSessionExpiry, createSessionFetch, installSessionFetch, subscribeToSessionExpiry } from "./session-expiry";

const sessionError = { error: { code: "UNAUTHENTICATED", message: "Authentication required" } };
let onExpired: ReturnType<typeof vi.fn>;
let unsubscribe: () => void;

beforeEach(() => {
  const target = Object.assign(new EventTarget(), { location: new URL("https://study.example/opening/courses/c1?tab=units#q2") });
  vi.stubGlobal("window", target);
  onExpired = vi.fn();
  unsubscribe = subscribeToSessionExpiry(onExpired);
});
afterEach(() => { unsubscribe(); clearSessionExpiry(); vi.unstubAllGlobals(); });

describe("session expiry transport", () => {
  it("notifies once across concurrent requests and separate clients without consuming their responses", async () => {
    const response = () => Response.json(sessionError, { status: 401 });
    const first = createSessionFetch(vi.fn(async () => response()));
    const second = createSessionFetch(vi.fn(async () => response()));
    const results = await Promise.all([first("/api/opening/today"), second("/api/reviews"), first("/api/opening/teaching-activities")]);
    expect(onExpired).toHaveBeenCalledOnce();
    for (const result of results) expect(await result.json()).toEqual(sessionError);
    clearSessionExpiry();
    await first("/api/opening/today");
    expect(onExpired).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, { error: { code: "PROVIDER_AUTH" } }],
    [401, { error: { code: "INVALID_CREDENTIALS" } }],
    [401, { error: { message: "unauthorized" } }],
    [403, sessionError], [429, sessionError], [500, sessionError],
  ])("does not infer expiry from status %s and error %j", async (status, body) => {
    const response = Response.json(body, { status });
    expect(await createSessionFetch(vi.fn(async () => response))("/api/opening/ephemeral")).toBe(response);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("leaves a non-JSON 401 available to the existing request error handler", async () => {
    const response = new Response("Unauthorized gateway", { status: 401 });
    const result = await createSessionFetch(vi.fn(async () => response))("/api/opening/today");
    expect(await result.text()).toBe("Unauthorized gateway");
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("ignores an old request that finishes after a successful session recheck", async () => {
    let finish!: (response: Response) => void;
    const request = createSessionFetch(vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })))("/api/opening/today");
    clearSessionExpiry();
    finish(Response.json(sessionError, { status: 401 }));
    expect((await request).status).toBe(401);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("blocks subsequent reads and writes before transport until the original session is verified", async () => {
    const transport = vi.fn(async () => Response.json(sessionError, { status: 401 }));
    const request = createSessionFetch(transport);
    await request("/api/opening/today");
    const write = await request("/api/opening/conversations", { method: "POST", body: "private draft" });
    const read = await request("/api/opening/conversations");
    expect(write.status).toBe(401);
    expect(read.status).toBe(401);
    expect(transport).toHaveBeenCalledTimes(1);
    clearSessionExpiry();
    transport.mockResolvedValueOnce(Response.json({ id: "saved" }));
    expect((await request("/api/opening/conversations", { method: "POST" })).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not handle external requests, login requests, login pages, or aborted requests", async () => {
    const transport = createSessionFetch(vi.fn(async () => Response.json(sessionError, { status: 401 })));
    await transport("https://provider.example/api/chat");
    await transport("/api/auth/login");
    const controller = new AbortController();
    controller.abort();
    await transport("/api/opening/today", { signal: controller.signal });
    window.location.href = "https://study.example/login?returnTo=%2Fopening";
    await transport("/api/opening/today");
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("is inert during server execution and preserves network failures", async () => {
    vi.stubGlobal("window", undefined);
    const response = Response.json(sessionError, { status: 401 });
    expect(await createSessionFetch(vi.fn(async () => response))("/api/opening/today")).toBe(response);
    const failure = new TypeError("network unavailable");
    await expect(createSessionFetch(vi.fn(async () => { throw failure; }))("/api/opening/today")).rejects.toBe(failure);
    expect(onExpired).not.toHaveBeenCalled();
    // Restore the event target for listener cleanup.
    vi.unstubAllGlobals();
    unsubscribe = () => undefined;
  });

  it("covers main, learning, card and nested proposal clients while preserving their errors", async () => {
    const transport = vi.fn(async () => Response.json(sessionError, { status: 401 }));
    const main = createOpeningApi(transport);
    const learning = createOpeningLearningClient(transport);
    const cards = createOpeningCardsClient(transport);
    for (const request of [() => main.listConversations(), () => main.listAssistantProposals(), () => main.getCoachAcceptance("2026-10-20"), () => learning.getSummary("c1"), () => cards.listDue()]) {
      await expect(request()).rejects.toBeInstanceOf(OpeningApiError);
    }
    expect(onExpired).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});


describe("global session fetch installation", () => {
  it("protects module-created clients even when they were constructed before the global install", async () => {
    const original = vi.fn(async () => Response.json(sessionError, { status: 401 }));
    vi.stubGlobal("fetch", original);
    const course = createCourseStateClient();
    const source = createSourceActionsClient();
    const measurement = createMeasurementClient();
    // These are also safe without an active gate; their local guard owns the same latch.
    await expect(measurement.read("course1")).rejects.toThrow("登录状态已过期");
    await expect(course.removeAsset("course1", { assetId: "source1", assetType: "source" })).rejects.toThrow("登录状态已过期");
    await expect(source.act("source1", { action: "retry_cleanup" })).rejects.toMatchObject({ status: 401 });
    await expect(measurement.act("attempt1", { action: "answer", clientKey: "client-key-123", answer: "A private answer" })).rejects.toThrow("登录状态已过期");
    expect(original).toHaveBeenCalledOnce();
    expect(onExpired).toHaveBeenCalledOnce();
    clearSessionExpiry();
    const afterInstall = vi.fn(async () => Response.json(sessionError, { status: 401 }));
    vi.stubGlobal("fetch", afterInstall);
    await expect(measurement.read("course1")).rejects.toThrow("登录状态已过期");
    expect(afterInstall).toHaveBeenCalledOnce();
    expect(original).toHaveBeenCalledOnce();
  });

  it("covers raw fetch with native receiver binding, deduplicates nested wrappers and blocks later writes", async () => {
    const original = vi.fn(function (this: Window) {
      expect(this).toBe(window);
      return Promise.resolve(Response.json(sessionError, { status: 401 }));
    });
    window.fetch = original;
    const uninstall = installSessionFetch();
    try {
      const wrappedClient = createSessionFetch(window.fetch);
      await Promise.all([window.fetch("/api/opening/today"), wrappedClient("/api/opening/courses")]);
      expect(onExpired).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledTimes(2);
      expect((await window.fetch("/api/opening/conversations", { method: "POST", body: "A draft" })).status).toBe(401);
      expect(original).toHaveBeenCalledTimes(2);
      clearSessionExpiry();
      original.mockResolvedValueOnce(Response.json({ id: "saved" }));
      expect((await window.fetch("/api/opening/conversations", { method: "POST" })).ok).toBe(true);
    } finally { uninstall(); }
    expect(window.fetch).toBe(original);
  });

  it("leaves external/provider/auth failures and non-JSON 401s unchanged", async () => {
    const original = vi.fn<typeof fetch>();
    window.fetch = original;
    const uninstall = installSessionFetch();
    try {
      for (const [url, response] of [
        ["https://provider.example/api/chat", Response.json(sessionError, { status: 401 })],
        ["/api/auth/me", Response.json(sessionError, { status: 401 })],
        ["/api/opening/tutor", Response.json({ error: { code: "PROVIDER_AUTH" } }, { status: 401 })],
        ["/api/opening/today", new Response("gateway unavailable", { status: 401 })],
      ] as const) {
        original.mockResolvedValueOnce(response);
        expect(await window.fetch(url)).toBe(response);
      }
      expect(onExpired).not.toHaveBeenCalled();
    } finally { uninstall(); }
  });

  it("ignores a late raw-fetch 401 after successful identity revalidation", async () => {
    let finish!: (response: Response) => void;
    window.fetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const uninstall = installSessionFetch();
    try {
      const request = window.fetch("/api/opening/today");
      clearSessionExpiry();
      finish(Response.json(sessionError, { status: 401 }));
      expect((await request).status).toBe(401);
      expect(onExpired).not.toHaveBeenCalled();
    } finally { uninstall(); }
  });

  it("shares overlapping gate ownership and cleans up idempotently before reinstalling", () => {
    const original = vi.fn<typeof fetch>();
    window.fetch = original;
    const first = installSessionFetch();
    const wrapped = window.fetch;
    const second = installSessionFetch();
    expect(window.fetch).toBe(wrapped);
    first(); first();
    expect(window.fetch).toBe(wrapped);
    second();
    expect(window.fetch).toBe(original);
    const strictModeRemount = installSessionFetch();
    expect(window.fetch).not.toBe(original);
    strictModeRemount();
    expect(window.fetch).toBe(original);
  });

  it("does not overwrite a fetch installed later by another owner", () => {
    window.fetch = vi.fn<typeof fetch>();
    const uninstall = installSessionFetch();
    const laterFetch = vi.fn<typeof fetch>();
    window.fetch = laterFetch;
    uninstall();
    expect(window.fetch).toBe(laterFetch);
  });
});
