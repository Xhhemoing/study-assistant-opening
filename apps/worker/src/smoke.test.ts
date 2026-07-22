import { describe, expect, it } from "vitest";
import { processSmokeJob } from "./index";

describe("worker smoke job", () => {
  it("validates payload and echoes message", () => {
    expect(processSmokeJob({ kind: "smoke", message: "hello" })).toEqual({
      platform: "AIstudy",
      echo: "hello",
    });
  });

  it("rejects invalid payload", () => {
    expect(() => processSmokeJob({ kind: "other" })).toThrow();
  });
});
