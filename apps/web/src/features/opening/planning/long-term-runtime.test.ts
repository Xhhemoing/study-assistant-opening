import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningLongTermPlanningRepository } from "@aistudy/database";
import { createLongTermPlanningService } from "./long-term-service";
import { getLongTermPlanningService } from "./long-term-runtime";
import { compilerFlagMatrix } from "../../../../../../tests/fixtures/opening/teaching/compiler-flag-matrix";

vi.mock("@aistudy/database", () => ({
  createOpeningLongTermPlanningRepository: vi.fn(() => ({})),
  readLearningCardSessions: vi.fn(),
  writeLearningCardSession: vi.fn(),
}));
vi.mock("./long-term-service", () => ({ createLongTermPlanningService: vi.fn(() => ({})) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("long-term planning runtime compiler and exact verification switches", () => {
  it.each(compilerFlagMatrix)("wires real process environment semantics: $name", ({ opening, legacy, enabled }) => {
    vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", opening);
    vi.stubEnv("TEACHING_COMPILER_ENABLED", legacy);
    const now = new Date("2026-01-01T10:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const sql = vi.fn() as unknown as Sql;
    const service = getLongTermPlanningService(sql);

    expect(createOpeningLongTermPlanningRepository).toHaveBeenCalledExactlyOnceWith(sql, expect.any(Function), {
      compilerEnabled: enabled, exactVerificationEnabled: enabled,
    });
    const repository = vi.mocked(createOpeningLongTermPlanningRepository);
    const clock = repository.mock.calls[0]![1]!;
    expect(clock()).toEqual(now);
    vi.setSystemTime(new Date(now.getTime() + 1_000));
    expect(clock()).toEqual(new Date(now.getTime() + 1_000));
    expect(createLongTermPlanningService).toHaveBeenCalledExactlyOnceWith(repository.mock.results[0]!.value, {
      read: expect.any(Function), write: expect.any(Function),
    });
    expect(service).toBe(vi.mocked(createLongTermPlanningService).mock.results[0]!.value);
    expect(sql).not.toHaveBeenCalled();
  });
});
