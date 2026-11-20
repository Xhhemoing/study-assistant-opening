import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import PublicTryPage, { dynamic as tryDynamic } from "../../../app/try/page";

afterEach(() => vi.unstubAllEnvs());

const pageProps = { searchParams: Promise.resolve({}) };

it("serves an anonymous challenge with the controlled account entry", async () => {
  vi.stubEnv("OPENING_PUBLIC_TRY", "1");
  vi.stubEnv("OPENING_RELEASE", "1");
  expect((await PublicTryPage(pageProps)).props.entry).toBe("/login");
  vi.stubEnv("OPENING_RELEASE", "0");
  expect((await PublicTryPage(pageProps)).props.entry).toBe("/register");
});

it("renders a calm login fallback page instead of 404 when the challenge is disabled", async () => {
  expect(tryDynamic).toBe("force-dynamic");
  vi.stubEnv("OPENING_PUBLIC_TRY", "0");
  const element = await PublicTryPage(pageProps);
  const html = renderToStaticMarkup(element);

  expect(html).toContain("公开体验挑战暂未开放");
  expect(html).toContain("当前环境已关闭免登录挑战入口，你可以直接登录进入完整学习空间。");
  expect(html).toContain('href="/login"');
  expect(html).toContain("登录进入学习空间");
});
