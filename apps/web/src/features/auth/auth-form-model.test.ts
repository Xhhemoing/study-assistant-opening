import { describe, expect, it } from "vitest";
import { loginHrefForReturn, safeAuthReturnPath, validateLoginInput, validateRegisterInput } from "./auth-form-model";

describe("auth form validation", () => {
  it("requires a valid email and password for login", () => {
    expect(validateLoginInput({ email: "bad", password: "" })).toEqual({
      email: "请输入有效的邮箱地址",
      password: "请输入密码",
    });
    expect(validateLoginInput({ email: "user@example.com", password: "secret" })).toEqual({});
  });

  it("requires registration fields and matching passwords", () => {
    expect(
      validateRegisterInput({
        displayName: "",
        email: "bad",
        password: "short",
        confirmPassword: "different",
      }),
    ).toEqual({
      displayName: "请输入显示名称",
      email: "请输入有效的邮箱地址",
      password: "密码至少需要 8 个字符",
      confirmPassword: "两次输入的密码不一致",
    });
  });
});


describe("login return destinations", () => {
  it("preserves local deep links, filters, and the original anchor", () => {
    const path = "/library/note-1?course=c1#block-3";
    expect(safeAuthReturnPath(path)).toBe(path);
    const loginUrl = new URL(loginHrefForReturn(path), "https://study.example");
    expect(loginUrl.pathname).toBe("/login");
    expect(safeAuthReturnPath(loginUrl.searchParams.get("returnTo"))).toBe(path);
  });
  it("rejects external, ambiguous, malformed, and login-loop destinations", () => {
    for (const value of [null, [], "https://evil.example", "//evil.example", "/\\evil.example", "/%5cevil.example", "/%2f%2fevil.example", "/..//evil.example", "/%0a/evil.example", "/%", "/login", "/register?returnTo=/learn"]) {
      expect(safeAuthReturnPath(value), String(value)).toBeNull();
    }
    expect(loginHrefForReturn("//evil.example")).toBe("/login");
  });
});
