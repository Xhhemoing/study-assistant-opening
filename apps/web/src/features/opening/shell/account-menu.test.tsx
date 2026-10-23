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
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("every-page more menu", () => {
  it("makes tools, full history, settings and theme available after opening once", async () => {
    await act(async () => root.render(<OpeningAccountMenu userLabel="学生" pendingCount={null} focusMode={false} onToggleFocus={() => {}} onLogout={() => {}} logoutPending={false} />));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="更多"]')!;
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]');
    for (const href of ["/opening/sprint", "/opening/cards", "/opening/search", "/opening/assistant", "/opening/settings"]) {
      expect(dialog?.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
    expect(dialog?.querySelector("select")?.textContent).toContain("跟随系统");
    await act(async () => (dialog?.querySelector('[aria-label="关闭抽屉"]') as HTMLButtonElement).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it.each(["/opening/sprint", "/opening/cards/session", "/opening/search"])("highlights only the matching tool for %s", async pathname => {
    await act(async () => root.render(<OpeningAccountMenu pathname={pathname} userLabel="" pendingCount={null} focusMode={false} onToggleFocus={() => {}} onLogout={() => {}} logoutPending={false} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多"]')!.click());
    const selected = document.querySelectorAll('[role="dialog"] a[aria-current="page"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("href")).toBe(pathname.startsWith("/opening/cards/") ? "/opening/cards" : pathname);
  });

  it.each([
    ["/opening/review", "tab=cards", "/opening/cards"],
    ["/opening/courses/course-a", "mode=sprint", "/opening/sprint"],
  ])("highlights the redirected tool at %s", async (pathname, search, expected) => {
    await act(async () => root.render(<OpeningAccountMenu pathname={pathname} search={search} userLabel="" pendingCount={null} focusMode={false} onToggleFocus={() => {}} onLogout={() => {}} logoutPending={false} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="更多"]')!.click());
    const selected = document.querySelectorAll('[role="dialog"] a[aria-current="page"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("href")).toBe(expected);
  });

});
