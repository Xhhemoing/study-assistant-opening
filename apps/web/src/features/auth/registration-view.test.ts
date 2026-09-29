import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import RegisterPage from "../../app/register/page";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("registration page", () => {
  it("shows the closed registration page in opening release without redirecting", () => {
    vi.stubEnv("OPENING_RELEASE", "1");
    const html = renderToStaticMarkup(RegisterPage());
    expect(redirect).not.toHaveBeenCalled();
    expect(html).toContain("创建你的学习空间");
    expect(html).toContain("当前版本仅对已有账户开放。");
    expect(html).toMatch(/<fieldset[^>]*disabled=""[^>]*aria-describedby="registration-status"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain('href="/login"');
  });

  it("enables registration outside opening release with accessible field constraints", () => {
    vi.stubEnv("OPENING_RELEASE", "0");
    const html = renderToStaticMarkup(RegisterPage());
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("注册暂未开放");
    const inputs = Object.fromEntries([...html.matchAll(/<input\b[^>]*\bname="([^"]+)"[^>]*>/g)].map(([tag, name]) => [name, tag]));
    for (const [name, type, autoComplete, maxLength] of [
      ["displayName", "text", "name", 120], ["email", "email", "email", 320],
      ["password", "password", "new-password", 200], ["confirmPassword", "password", "new-password", 200],
    ] as const) {
      expect(inputs[name]).toContain(`type="${type}"`);
      expect(inputs[name]).toContain(`autoComplete="${autoComplete}"`);
      expect(inputs[name]).toContain(`maxLength="${maxLength}"`);
      expect(inputs[name]).toContain('required=""');
      expect(html).toContain(`for="auth-${name}"`);
    }
    expect(inputs.password).toContain('minLength="8"');
    expect(html).toContain('aria-describedby="auth-password-hint"');
    expect(html).toContain('id="auth-password-hint"');
    expect(html).toContain('type="button" aria-label="显示密码" aria-pressed="false"');
    expect(html).toContain('type="button" aria-label="显示确认密码" aria-pressed="false"');
    expect(html).toContain('href="/login"');
    expect(html).toContain("创建账户");
  });
});
