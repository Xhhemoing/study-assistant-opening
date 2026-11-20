// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LoginPage from "../../app/login/page";
import RegisterPage from "../../app/register/page";
import PublicTryPage from "../../app/try/page";
import type { TrySearchParams } from "../opening/public-try/continuation";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", async original => ({
  ...await original<typeof import("next/navigation")>(),
  useRouter: () => ({ replace, refresh: vi.fn() }),
}));

const valid = { from: "try", challenge: "matrix", step: "1" };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubEnv("OPENING_RELEASE", "0");
  vi.stubEnv("OPENING_PUBLIC_TRY", "1");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  replace.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function visit(mode: "login" | "register", params: TrySearchParams) {
  const page = mode === "login" ? LoginPage : RegisterPage;
  const element = await page({ searchParams: Promise.resolve(params) });
  act(() => root.render(element));
}

async function submit() {
  for (const input of host.querySelectorAll<HTMLInputElement>("input")) {
    input.value = input.name === "email" ? "learner@example.com" : "sample-input";
  }
  await act(async () => { host.querySelector("form")!.requestSubmit(); });
}

it.each(["login", "register"] as const)("carries the challenge across the switch link, %s success and the return page", async mode => {
  await visit(mode === "login" ? "register" : "login", { ...valid, returnTo: "https://outside.example", extra: "discard" });
  const switchHref = host.querySelector<HTMLAnchorElement>(`a[href^="/${mode}?"]`)!.getAttribute("href")!;
  expect(switchHref).toBe(`/${mode}?from=try&challenge=matrix&step=1`);
  const params = Object.fromEntries(new URL(switchHref, location.origin).searchParams);
  await visit(mode, params);
  await submit();
  const expected = `/try?from=try&challenge=matrix&step=1&continued=${mode}`;
  expect(replace).toHaveBeenCalledWith(expected);
  expect(host.querySelector(`a[href="${expected}"]`)).toBeTruthy();

  const result = await PublicTryPage({ searchParams: Promise.resolve(Object.fromEntries(new URL(expected, location.origin).searchParams)) });
  act(() => root.render(result));
  expect(host.textContent).toContain("AB = AC");
  expect(host.textContent).toContain("你选择了第 2 步");
  expect(host.textContent).toContain("错在第 4 步");
  expect(host.querySelector("a")?.getAttribute("href")).toBe(mode === "register" ? "/onboarding" : "/");
});

it.each(["login", "register"] as const)("uses default links and destination for an invalid %s continuation", async mode => {
  await visit(mode, { ...valid, challenge: "//outside.example", returnTo: "https://outside.example" });
  expect(host.querySelector(`a[href="/${mode === "login" ? "register" : "login"}"]`)).toBeTruthy();
  expect(host.querySelector("a[href*='outside.example']")).toBeNull();
  await submit();
  expect(replace).toHaveBeenCalledWith(mode === "login" ? "/" : "/onboarding");
});

it("retains a valid login link while registration is closed", async () => {
  vi.stubEnv("OPENING_RELEASE", "1");
  await visit("register", valid);
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
  expect(host.querySelector("a[href='/login?from=try&challenge=matrix&step=1']")).toBeTruthy();
  await visit("login", valid);
  expect(host.querySelector("a[href^='/register']")).toBeNull();
});

it("uses ordinary login when the public challenge has since been disabled", async () => {
  vi.stubEnv("OPENING_PUBLIC_TRY", "0");
  await visit("login", valid);
  await submit();
  expect(replace).toHaveBeenCalledWith("/");
});
