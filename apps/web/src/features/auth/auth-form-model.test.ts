import { describe, expect, it } from "vitest";
import { validateLoginInput, validateRegisterInput } from "./auth-form-model";

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
