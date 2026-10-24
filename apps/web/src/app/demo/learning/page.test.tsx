import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("../../../features/auth/auth-gate", () => ({ AuthGate: () => null }));
vi.mock("../../../features/opening/demo/demo-lesson", () => ({ DemoLesson: () => null }));
import DemoLearningPage, { dynamic } from "./page";
afterEach(() => { vi.unstubAllEnvs(); mocks.notFound.mockClear(); });
it.each([undefined, "0", "false"])("returns not-found for unset/OFF %s direct URL", value => {
  vi.stubEnv("OPENING_EXPLORE_PREVIEW", value);
  expect(() => DemoLearningPage()).toThrow("NEXT_NOT_FOUND");
  expect(mocks.notFound).toHaveBeenCalledOnce();
});
it("ON retains the authenticated static demo and evaluates per request", () => {
  vi.stubEnv("OPENING_EXPLORE_PREVIEW", "1");
  expect(dynamic).toBe("force-dynamic");
  expect(DemoLearningPage().props.children).toBeTruthy();
  expect(mocks.notFound).not.toHaveBeenCalled();
  vi.stubEnv("OPENING_EXPLORE_PREVIEW", "0");
  expect(() => DemoLearningPage()).toThrow("NEXT_NOT_FOUND");
});
