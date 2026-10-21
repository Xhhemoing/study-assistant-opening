import { describe, expect, it } from "vitest";
import { isTeachingCompilerEnabled } from "./teaching-compiler";

describe("teaching compiler configuration", () => {
  it.each([{}, { OPENING_TEACHING_COMPILER_ENABLED: "" }, { OPENING_TEACHING_COMPILER_ENABLED: "  " },
    { OPENING_TEACHING_COMPILER_ENABLED: " true " }, { OPENING_TEACHING_COMPILER_ENABLED: " YES " }])("defaults to real generation and accepts normalized true: %j", env => {
    expect(isTeachingCompilerEnabled(env)).toBe(true);
  });
  it.each([{ OPENING_TEACHING_COMPILER_ENABLED: "0" }, { TEACHING_COMPILER_ENABLED: "0" },
    { OPENING_TEACHING_COMPILER_ENABLED: " 0 ", TEACHING_COMPILER_ENABLED: "1" },
    { OPENING_TEACHING_COMPILER_ENABLED: "", TEACHING_COMPILER_ENABLED: " false " }])("honors an explicit off switch: %j", env => {
    expect(isTeachingCompilerEnabled(env)).toBe(false);
  });
});
