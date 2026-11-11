import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningCourseRouteRepository, createOpeningCourseRouteRetestRepository, createOpeningCourseRouteVerificationRepository } from "@aistudy/database";
import { createCourseRouteService } from "./course-route-service";
import { compilerFlagMatrix } from "../../../../../../tests/fixtures/opening/teaching/compiler-flag-matrix";

vi.mock("@aistudy/database", () => ({
  createOpeningCourseRouteRepository: vi.fn(() => ({})),
  createOpeningCourseRouteRetestRepository: vi.fn(() => ({})),
  createOpeningCourseRouteVerificationRepository: vi.fn(() => ({})),
}));

afterEach(() => vi.clearAllMocks());

describe("course route factory compiler and exact verification switches", () => {
  it.each(compilerFlagMatrix)("wires real flag semantics: $name", ({ opening, legacy, enabled }) => {
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
