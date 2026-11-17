import { afterEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningSpanTutorNextRepository } from "@aistudy/database";
import { createSpanNextActionService } from "./next-action-service";
import { compilerFlagMatrix } from "../../../../../../../tests/fixtures/opening/teaching/compiler-flag-matrix";

vi.mock("@aistudy/database", () => ({ createOpeningSpanTutorNextRepository: vi.fn(() => ({})) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each(compilerFlagMatrix)("span next factory keeps compiler/exact aligned: $name", ({ opening, legacy, enabled }) => {
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", opening);
  vi.stubEnv("TEACHING_COMPILER_ENABLED", legacy);
  const sql = vi.fn() as unknown as Sql;
  createSpanNextActionService(sql);
  expect(createOpeningSpanTutorNextRepository).toHaveBeenCalledExactlyOnceWith(sql, {
    compilerEnabled: enabled, exactVerificationEnabled: enabled,
  });
  expect(sql).not.toHaveBeenCalled();
});
