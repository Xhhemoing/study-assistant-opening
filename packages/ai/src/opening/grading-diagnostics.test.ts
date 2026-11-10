import { expect, it, vi } from "vitest";
import type { ProviderInput } from "@aistudy/contracts";
import { createOpeningProvider, OpeningProviderError, logGradingDiagnostic, readGradingDiagnostic, recordGradingDiagnostic } from "./provider";
import { runBudgetedCall } from "./budgeted-call";

const input: ProviderInput = { instruction: "fixture", text: "fixture", mode: "explain", chunks: [], imageParts: [], mediaCapability: "text_only", maxOutputTokens: 64, outputFormat: "json" };
const sensitive = "sk-secret https://private.example prompt answer rawresponse message stack";
const body = { choices: [{ message: { content: '{"fixture":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };

it.each([502, 503])("retains real HTTP %i and attempted fetch without provider response content", async status => {
  const fetchImpl = vi.fn(async () => new Response(sensitive, { status }));
  const provider = createOpeningProvider({ baseUrl: "https://fixture.example", apiKey: sensitive, model: "fixture", fetchImpl });
  const error = await provider.complete(input).catch(error => error);
  expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", httpStatus: status });
  expect(readGradingDiagnostic(error)).toEqual({ phase: "provider", errorClass: "OpeningProviderError", code: "PROVIDER_UNAVAILABLE", attemptedFetch: true, httpStatus: status });
  expect(JSON.stringify(readGradingDiagnostic(error))).not.toContain(sensitive);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("does not trust error diagnostics, class names, arbitrary code/status or non-boolean markers", () => {
  const error = Object.assign(new Error(sensitive), { name: sensitive, code: sensitive, httpStatus: 503, requestSent: true,
    diagnostic: { phase: sensitive, code: "PROVIDER_AUTH", attemptedFetch: true, httpStatus: 503 }, endpoint: sensitive, key: sensitive });
  expect(readGradingDiagnostic(error)).toBeUndefined();
  recordGradingDiagnostic(error, "persist");
  expect(readGradingDiagnostic(error)).toEqual({ phase: "persist", errorClass: "Error", code: "UNKNOWN", attemptedFetch: null });
  const copy = readGradingDiagnostic(error)!; copy.code = "PROVIDER_AUTH";
  expect(readGradingDiagnostic(error)?.code).toBe("UNKNOWN");
  const forged = new OpeningProviderError(sensitive, sensitive, false, true, 503);
  recordGradingDiagnostic(forged, sensitive as never, { attemptedFetch: sensitive as never, httpStatus: Number.NaN });
  expect(readGradingDiagnostic(forged)).toEqual({ phase: "admission", errorClass: "OpeningProviderError", code: "UNKNOWN", attemptedFetch: null });
});

it.each(["parse", "persist", "settle", "usage"] as const)("identifies %s from the actual boundary without releasing or resending", async phase => {
  const fetchImpl = vi.fn(async () => new Response(phase === "parse" ? sensitive : JSON.stringify(body), { status: 200 }));
  const provider = createOpeningProvider({ baseUrl: "https://fixture.example", apiKey: sensitive, model: "fixture", fetchImpl });
  const budget = { reserve: vi.fn(async () => ({ id: "reservation" })), claimExecution: vi.fn(async () => true),
    markUnknown: vi.fn(async () => undefined), release: vi.fn(), settle: vi.fn(async () => { if (phase === "settle") throw new Error(sensitive); }) };
  const persistResult = vi.fn(async () => { if (phase === "persist") throw Object.assign(new Error(sensitive), { code: sensitive }); });
  const error = await runBudgetedCall({ provider, budget, input, requestId: "fixture", reservedCents: 9,
    actualCents: () => { if (phase === "usage") throw new Error(sensitive); return 1; }, persistResult }).catch(error => error);
  expect(readGradingDiagnostic(error)).toEqual({ phase, errorClass: phase === "parse" ? "OpeningProviderError" : "Error",
    code: phase === "parse" ? "PROVIDER_RESPONSE" : "UNKNOWN", attemptedFetch: true, httpStatus: 200 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(budget.release).not.toHaveBeenCalled();
  if (phase === "parse" || phase === "persist") expect(budget.markUnknown).toHaveBeenCalledExactlyOnceWith("reservation");
});

it("logs only fixed diagnostic fields and canonical operation identities", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const error = Object.assign(new Error(sensitive), { code: sensitive, endpoint: sensitive, stack: sensitive });
    recordGradingDiagnostic(error, "settle");
    logGradingDiagnostic(error, sensitive);
    expect(warn).not.toHaveBeenCalled();
    const operationId = "ai-grade:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:1";
    logGradingDiagnostic(error, operationId);
    expect(warn).toHaveBeenCalledExactlyOnceWith({ event: "grading_diagnostic", operationId, phase: "settle", errorClass: "Error", code: "UNKNOWN", attemptedFetch: null });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);
  } finally { warn.mockRestore(); }
});

it("records a caller abort before fetch as false, and an unobserved adapter transport as unknown", async () => {
  const fetchImpl = vi.fn();
  const provider = createOpeningProvider({ baseUrl: "https://fixture.example", apiKey: sensitive, model: "fixture", fetchImpl });
  const controller = new AbortController(); controller.abort();
  const error = await provider.complete(input, controller.signal).catch(error => error);
  expect(readGradingDiagnostic(error)).toEqual({ phase: "provider", errorClass: "OpeningProviderError", code: "PROVIDER_ABORTED", attemptedFetch: false });
  expect(fetchImpl).not.toHaveBeenCalled();
  const unobserved = new OpeningProviderError("PROVIDER_NETWORK", sensitive, true, true, 503);
  recordGradingDiagnostic(unobserved, "provider");
  expect(readGradingDiagnostic(unobserved)).toMatchObject({ attemptedFetch: null });
  expect(readGradingDiagnostic(unobserved)).not.toHaveProperty("httpStatus");
});
