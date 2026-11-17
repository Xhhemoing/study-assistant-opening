import { afterEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createCourseRouteService } from "./course-route-service";
import { createOpeningCourseRouteRepository, createOpeningCourseRouteRetestRepository, createOpeningCourseRouteVerificationRepository } from "@aistudy/database";

vi.mock("@aistudy/database", () => ({ createOpeningCourseRouteRepository: vi.fn(() => ({})),
  createOpeningCourseRouteRetestRepository: vi.fn(() => ({})), createOpeningCourseRouteVerificationRepository: vi.fn(() => ({})) }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it.each([true, false])("omitted env reads the process at each factory call; first enabled=%s", first => {
  const sql = vi.fn() as unknown as Sql;
  vi.stubEnv("TEACHING_COMPILER_ENABLED", undefined);
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", first ? "1" : "0");
  createCourseRouteService(sql);
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", first ? "0" : "1");
  createCourseRouteService(sql);
  expect(createOpeningCourseRouteRepository).toHaveBeenNthCalledWith(1, sql, { compilerEnabled: first, exactVerificationEnabled: first });
  expect(createOpeningCourseRouteRepository).toHaveBeenNthCalledWith(2, sql, { compilerEnabled: !first, exactVerificationEnabled: !first });
});

it.each([true, false])("explicit env isolates process configuration and is sampled on construction; enabled=%s", enabled => {
  const sql = vi.fn() as unknown as Sql;
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", enabled ? "0" : "1");
  vi.stubEnv("TEACHING_COMPILER_ENABLED", enabled ? "0" : "1");
  const env = { OPENING_TEACHING_COMPILER_ENABLED: enabled ? "1" : "0" };
  createCourseRouteService(sql, env);
  env.OPENING_TEACHING_COMPILER_ENABLED = enabled ? "0" : "1";
  createCourseRouteService(sql, env);
  for (const factory of [createOpeningCourseRouteRetestRepository, createOpeningCourseRouteVerificationRepository]) {
    expect(factory).toHaveBeenNthCalledWith(1, sql, { exactVerificationEnabled: enabled });
    expect(factory).toHaveBeenNthCalledWith(2, sql, { exactVerificationEnabled: !enabled });
  }
  expect(createOpeningCourseRouteRepository).toHaveBeenNthCalledWith(1, sql, { compilerEnabled: enabled, exactVerificationEnabled: enabled });
  expect(createOpeningCourseRouteRepository).toHaveBeenNthCalledWith(2, sql, { compilerEnabled: !enabled, exactVerificationEnabled: !enabled });
});

it("explicit empty env uses default, never leaks a disabled ambient environment", () => {
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "0");
  vi.stubEnv("TEACHING_COMPILER_ENABLED", "0");
  const sql = vi.fn() as unknown as Sql;
  createCourseRouteService(sql, {});
  expect(createOpeningCourseRouteRepository).toHaveBeenCalledExactlyOnceWith(sql, { compilerEnabled: true, exactVerificationEnabled: true });
});

it.each(["route", "retest", "verification"])("construction error from %s is neither swallowed nor followed by later factories", failed => {
  const error = Object.assign(new Error("factory failed"), { code: "EDEPENDENCY" });
  const factories = [createOpeningCourseRouteRepository, createOpeningCourseRouteRetestRepository, createOpeningCourseRouteVerificationRepository];
  const index = ["route", "retest", "verification"].indexOf(failed);
  vi.mocked(factories[index]!).mockImplementationOnce(() => { throw error; });
  expect(() => createCourseRouteService(vi.fn() as unknown as Sql, {})).toThrow(error);
  factories.forEach((factory, n) => expect(factory).toHaveBeenCalledTimes(n <= index ? 1 : 0));
});
