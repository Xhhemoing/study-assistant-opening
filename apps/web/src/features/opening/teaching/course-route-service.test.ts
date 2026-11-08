import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningCourseRouteRepository, createOpeningCourseRouteRetestRepository, createOpeningCourseRouteVerificationRepository } from "@aistudy/database";
import { createCourseRouteService } from "./course-route-service";

vi.mock("@aistudy/database", () => ({
  createOpeningCourseRouteRepository: vi.fn(() => ({})),
  createOpeningCourseRouteRetestRepository: vi.fn(() => ({})),
  createOpeningCourseRouteVerificationRepository: vi.fn(() => ({})),
}));

afterEach(() => vi.clearAllMocks());

describe("course route factory compiler and exact verification switches", () => {
  it.each([
    { name: "opening enabled", opening: "1", legacy: undefined, enabled: true },
    { name: "opening disabled", opening: "0", legacy: undefined, enabled: false },
    { name: "legacy enabled", opening: undefined, legacy: "1", enabled: true },
    { name: "legacy disabled", opening: undefined, legacy: "0", enabled: false },
    { name: "both unset default enabled", opening: undefined, legacy: undefined, enabled: true },
    { name: "opening off overrides legacy on", opening: "0", legacy: "1", enabled: false },
    { name: "opening on overrides legacy off", opening: "1", legacy: "0", enabled: true },
  ])("wires real flag semantics: $name", ({ opening, legacy, enabled }) => {
    const sql = vi.fn() as unknown as Sql;
    createCourseRouteService(sql, {
      OPENING_TEACHING_COMPILER_ENABLED: opening,
      TEACHING_COMPILER_ENABLED: legacy,
    });

    expect(createOpeningCourseRouteRepository).toHaveBeenCalledExactlyOnceWith(sql, {
      compilerEnabled: enabled, exactVerificationEnabled: enabled,
    });
    expect(createOpeningCourseRouteRetestRepository).toHaveBeenCalledExactlyOnceWith(sql, { exactVerificationEnabled: enabled });
    expect(createOpeningCourseRouteVerificationRepository).toHaveBeenCalledExactlyOnceWith(sql, { exactVerificationEnabled: enabled });
    expect(sql).not.toHaveBeenCalled();
  });
});
