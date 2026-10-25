import { describe, expect, it } from "vitest";
import { z } from "zod";
import { userFacingMessage } from "./user-facing-error";

const fallback = "暂时无法读取，请重试。";

describe("userFacingMessage", () => {
  it("keeps short app-authored Chinese messages", () => {
    expect(userFacingMessage(new Error("课程已归档，无法添加材料。"), fallback)).toBe("课程已归档，无法添加材料。");
  });

  it("hides schema errors produced by response parsing", () => {
    const parsed = z.object({ total: z.number() }).safeParse({ total: "1" });
    expect(parsed.success).toBe(false);
    expect(userFacingMessage(parsed.error, fallback)).toBe(fallback);
  });

  it("hides JSON parse, network and abort failures", () => {
    expect(userFacingMessage(new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"), fallback)).toBe(fallback);
    expect(userFacingMessage(new TypeError("Failed to fetch"), fallback)).toBe(fallback);
    expect(userFacingMessage(Object.assign(new Error("aborted"), { name: "AbortError" }), fallback)).toBe(fallback);
  });

  it("hides English server messages and transport placeholders", () => {
    expect(userFacingMessage(new Error("Invalid credentials"), fallback)).toBe(fallback);
    expect(userFacingMessage(new Error("request failed (500)"), fallback)).toBe(fallback);
    expect(userFacingMessage(new Error("无法拉取 client-init；不会伪造讲义。"), fallback)).toBe(fallback);
  });

  it("falls back for non-Error values", () => {
    expect(userFacingMessage("boom", fallback)).toBe(fallback);
    expect(userFacingMessage(undefined, fallback)).toBe(fallback);
  });
});
