import { describe, expect, it } from "vitest";
import { authServerErrorMessage, loginHrefForReturn, safeAuthReturnPath, validateLoginInput, validateRegisterInput } from "./auth-form-model";

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

describe("authServerErrorMessage", () => {
  it("localizes English server auth errors by code", () => {
    expect(authServerErrorMessage({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } })).toBe("邮箱或密码不正确");
    expect(authServerErrorMessage({ error: { code: "CONFLICT", message: "Email already registered" } })).toBe("该邮箱已注册，请直接登录");
    expect(authServerErrorMessage({ error: { code: "VALIDATION", message: "Invalid request body" } })).toBe("请检查填写内容后重试");
  });
  it("keeps localized server copy and falls back for unknown English text", () => {
    expect(authServerErrorMessage({ error: { code: "RATE_LIMITED", message: "尝试次数过多，请稍后重试。" } })).toBe("尝试次数过多，请稍后重试。");
    expect(authServerErrorMessage({ error: { code: "INTERNAL", message: "boom" } })).toBe("暂时无法完成请求，请稍后重试");
    expect(authServerErrorMessage(null)).toBe("暂时无法完成请求，请稍后重试");
  });
});
