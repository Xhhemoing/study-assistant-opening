import { afterEach, expect, it, vi } from "vitest";
import { buildInfo } from "./build-info";

afterEach(() => vi.unstubAllEnvs());

it("does not invent a release identity for unversioned local builds", () => {
  vi.stubEnv("AISTUDY_COMMIT", "");
  vi.stubEnv("AISTUDY_BUILT_AT", "");
  expect(buildInfo()).toEqual({ commit: null, builtAt: null });
});

it("only exposes a commit identifier and a valid build timestamp", () => {
  vi.stubEnv("AISTUDY_COMMIT", "secret-or-path");
  vi.stubEnv("AISTUDY_BUILT_AT", "invalid");
  expect(buildInfo()).toEqual({ commit: null, builtAt: null });
});

it("pins release metadata in the Next build configuration", async () => {
  vi.stubEnv("AISTUDY_COMMIT", "189546c71095820f550bff754836f36e7fa17933");
  const { default: config } = await import("../../next.config.mjs");
  expect(config.env.AISTUDY_COMMIT).toBe("189546c71095820f550bff754836f36e7fa17933");
  expect(Number.isFinite(Date.parse(config.env.AISTUDY_BUILT_AT))).toBe(true);
  expect(Object.keys(config.env).some(key => key.startsWith("NEXT_PUBLIC_"))).toBe(false);
});

it("skips in-build type and lint checks only for the verified release runner", async () => {
  vi.resetModules();
  const { default: ordinary } = await import("../../next.config.mjs");
  expect(ordinary.typescript?.ignoreBuildErrors).not.toBe(true);
  expect(ordinary.eslint?.ignoreDuringBuilds).not.toBe(true);
  vi.resetModules();
  vi.stubEnv("AISTUDY_RELEASE_VERIFIED_SHA", "1");
  const { default: release } = await import("../../next.config.mjs");
  expect(release.typescript).toEqual({ ignoreBuildErrors: true });
  expect(release.eslint).toEqual({ ignoreDuringBuilds: true });
  expect(release.output).toBe("standalone");
});
