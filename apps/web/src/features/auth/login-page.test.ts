import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../../app/login/page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
afterEach(() => vi.unstubAllEnvs());

describe("login registration availability", () => {
  it("does not offer unavailable registration in opening release", async () => {
    vi.stubEnv("OPENING_RELEASE", "1");
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain('href="/register"');
    expect(html).toContain("仅对已有账户开放");
  });
  it("keeps registration reachable outside opening release", async () => {
    vi.stubEnv("OPENING_RELEASE", "0");
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('href="/register"');
  });
});
