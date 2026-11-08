import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningLongTermPlanningRepository } from "@aistudy/database";
import { createLongTermPlanningService } from "./long-term-service";
import { getLongTermPlanningService } from "./long-term-runtime";

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
  it.each([
    { name: "opening enabled", opening: "1", legacy: undefined, enabled: true },
    { name: "opening disabled", opening: "0", legacy: undefined, enabled: false },
    { name: "legacy enabled", opening: undefined, legacy: "1", enabled: true },
    { name: "legacy disabled", opening: undefined, legacy: "0", enabled: false },
    { name: "both unset default enabled", opening: undefined, legacy: undefined, enabled: true },
    { name: "opening off overrides legacy on", opening: "0", legacy: "1", enabled: false },
    { name: "opening on overrides legacy off", opening: "1", legacy: "0", enabled: true },
  ])("wires real process environment semantics: $name", ({ opening, legacy, enabled }) => {
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
