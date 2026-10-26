// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children) }));
vi.mock("./focus-timer", () => ({ FocusTimer: () => null }));
import { OpeningAccountMenu } from "./account-menu";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ commit: "189546c7", builtAt: "2026-10-25T20:00:00.000Z" })));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("every-page more menu", () => {
  it("keeps account destinations without repeating the three navigation items", async () => {
    await act(async () => root.render(<OpeningAccountMenu userLabel="学生" pendingCount={null} focusMode={false} onToggleFocus={() => {}} onLogout={() => {}} logoutPending={false} />));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="更多"]')!;
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]');
    for (const href of ["/opening/assistant", "/opening/settings/planning", "/opening/settings", "/opening/settings/export"]) {
      expect(dialog?.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
    for (const href of ["/opening/today", "/opening/review", "/opening/library", "/opening/sprint", "/opening/search"]) {
      expect(dialog?.querySelector(`a[href="${href}"]`)).toBeNull();
    }
    expect(dialog?.querySelector("select")?.textContent).toContain("跟随系统");
    await act(async () => (dialog?.querySelector('[aria-label="关闭抽屉"]') as HTMLButtonElement).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
it("loads the running release version only when the account menu opens", async () => {
  await act(async () => root.render(<OpeningAccountMenu userLabel="" pendingCount={null} focusMode={false} onToggleFocus={() => {}} onLogout={() => {}} logoutPending={false} />));
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多"]')!.click());
  expect(fetch).toHaveBeenCalledWith("/api/opening/health", expect.objectContaining({ cache: "no-store" }));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("版本 189546c7");
  expect(document.querySelector("time")?.dateTime).toBe("2026-10-25T20:00:00.000Z");
});

it("keeps account actions available if version lookup fails and retries on reopening", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<OpeningAccountMenu userLabel="" pendingCount={null} focusMode={false} onToggleFocus={() => {}} onLogout={() => {}} logoutPending={false} />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多"]')!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("版本暂不可用");
  expect(document.querySelector('a[href="/opening/settings"]')).not.toBeNull();
  await act(async () => (document.querySelector('[aria-label="关闭抽屉"]') as HTMLButtonElement).click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多"]')!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("版本 189546c7");
});