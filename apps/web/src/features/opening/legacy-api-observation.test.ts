import { expect, it, vi } from "vitest";
import { legacyApiObservation, recordLegacyApiRequest } from "./legacy-api-observation";

const options = { publicBaseUrl: "https://study.example", build: "abcdef012345", now: new Date("2026-10-26T12:00:00Z") };
it.each([
  ["/api/explorations", "GET", "/api/explorations"],
  ["/api/explorations/id", "GET", "/api/explorations/[id]"],
  ["/api/explorations/id/blocks", "POST", "/api/explorations/[id]/blocks"],
  ["/api/explorations/id/branches", "POST", "/api/explorations/[id]/branches"],
  ["/api/explorations/id/status", "PATCH", "/api/explorations/[id]/status"],
  ["/api/explorations/id/promotions", "GET", "/api/explorations/[id]/promotions"],
  ["/api/promotions/id/accept", "POST", "/api/promotions/[id]/accept"],
  ["/api/promotions/id/reject", "POST", "/api/promotions/[id]/reject"],
  ["/api/practice/id", "POST", "/api/practice/[id]"],
  ["/api/practice/id/hint", "POST", "/api/practice/[id]/hint"],
  ["/api/practice/id/reveal", "POST", "/api/practice/[id]/reveal"],
  ["/api/revision-proposals/id", "GET", "/api/revision-proposals/[id]"],
])("records the observed route %s as a template", (path, method, route) => {
  expect(legacyApiObservation(new Request(`https://study.example${path}`, { method }), options)).toMatchObject({
    event: "deprecated_api_request", route, method, observedAt: options.now.toISOString(), build: options.build,
  });
});

it.each(["/api/courses", "/api/documents/id", "/api/revision-proposals/id/review", "/api/revision-proposals/id/resolve", "/api/opening/practice", "/api/explorations-extra"])("leaves active and unrelated API %s alone", path => {
  expect(legacyApiObservation(new Request(`https://study.example${path}`), options)).toBeNull();
});

it("redacts resource ids, queries, request credentials and source page details without consuming the body", () => {
  const request = new Request("https://study.example/api/practice/private-item?token=query-secret", { method: "POST", body: "private-answer", headers: {
    authorization: "Bearer credential-secret", cookie: "session=private-cookie", referer: "https://study.example/opening/library/private-doc?query=personal", "user-agent": "personal-device",
  } });
  const event = legacyApiObservation(request, options);
  expect(event).toEqual({ event: "deprecated_api_request", observedAt: options.now.toISOString(), route: "/api/practice/[id]", method: "POST", caller: "opening.editor", callerSource: "same_origin_referer", build: options.build });
  expect(JSON.stringify(event)).not.toMatch(/private|personal|secret/);
  expect(request.bodyUsed).toBe(false);
});

it("treats caller hints as untrusted labels and never stores arbitrary header values", () => {
  const request = (hint: string, referer = "https://outside.example/opening/courses/secret") => new Request("https://study.example/api/explorations", { headers: { "x-aistudy-caller": hint, referer } });
  expect(legacyApiObservation(request("script"), options)).toMatchObject({ caller: "script", callerSource: "header_hint" });
  expect(legacyApiObservation(request("secret\tvalue"), options)).toMatchObject({ caller: "unknown", callerSource: "unknown" });
  expect(legacyApiObservation(request("", "https://user:password@study.example/opening/courses/x"), options)).toMatchObject({ caller: "unknown" });
});

it("logs each receipt, tolerates logger failure and rejects invalid build identifiers", () => {
  const request = new Request("https://study.example/api/explorations");
  const write = vi.fn();
  recordLegacyApiRequest(request, options, write); recordLegacyApiRequest(request, options, write);
  expect(write).toHaveBeenCalledTimes(2);
  expect(() => recordLegacyApiRequest(request, options, () => { throw new Error("log unavailable"); })).not.toThrow();
  expect(legacyApiObservation(request, { ...options, build: "secret-config" })).toMatchObject({ build: null });
});
