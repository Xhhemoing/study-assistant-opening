import { describe, expect, it } from "vitest";
import { EnvValidationError } from "./env";
import { loadOpeningJobStaleConfig } from "./opening-job-stale";
import { envSpec } from "./registry";

describe("loadOpeningJobStaleConfig", () => {
  it("defaults to 15 min for lesson generation and 10 min for tutor answers", () => {
    expect(loadOpeningJobStaleConfig({})).toEqual({ teachingGenerateStaleMs: 900_000, tutorJobStaleMs: 600_000 });
  });

  it("reads explicit values", () => {
    expect(loadOpeningJobStaleConfig({ OPENING_TEACHING_GENERATE_STALE_MS: "1800000", OPENING_TUTOR_JOB_STALE_MS: " 120000 " }))
      .toEqual({ teachingGenerateStaleMs: 1_800_000, tutorJobStaleMs: 120_000 });
  });

  it.each(["abc", "-1", "1000", "12.5", "86400001"])("rejects %j", (value) => {
    expect(() => loadOpeningJobStaleConfig({ OPENING_TEACHING_GENERATE_STALE_MS: value })).toThrow(EnvValidationError);
    expect(() => loadOpeningJobStaleConfig({ OPENING_TUTOR_JOB_STALE_MS: value })).toThrow(EnvValidationError);
  });

  it("is registered for web and worker with the same bounds", () => {
    for (const name of ["OPENING_TEACHING_GENERATE_STALE_MS", "OPENING_TUTOR_JOB_STALE_MS"]) {
      expect(envSpec(name)).toMatchObject({ kind: "int", min: 60_000, max: 86_400_000, consumers: ["web", "worker"], secret: false });
    }
  });
});
