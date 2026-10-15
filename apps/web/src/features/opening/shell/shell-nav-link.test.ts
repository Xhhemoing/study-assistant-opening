import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const effects: Array<() => unknown> = [];
const refs: Array<{ current: unknown }> = [];
let refIndex = 0;
let pathname = "/opening/today";

vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => unknown) => { effects.push(effect); },
  useRef: <T,>(initial: T) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({
  default: ({ children, href, onClick, ...props }: {
    children?: ReactNode;
    href: string;
    onClick?: (event: {
      defaultPrevented: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      button: number;
    }) => void;
  }) => createElement("a", { href, onClick, ...props }, children),
}));

import { ShellNavLink } from "./shell-nav-link";
import { SHELL_NAV_FALLBACK_MS } from "./shell-nav-link-model";

describe("ShellNavLink stalled soft-nav fallback", () => {
  const assign = vi.fn();

  beforeEach(() => {
    effects.length = 0;
    refs.length = 0;
    refIndex = 0;
    pathname = "/opening/today";
    assign.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearTimeout,
      setTimeout,
      location: { pathname: "/opening/today", assign },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderAndClick(href: string) {
    effects.length = 0;
    refIndex = 0;
    const tree = ShellNavLink({ href, children: "go" });
    for (const effect of effects) effect();
    const onClick = (tree as { props: { onClick?: (event: object) => void } }).props.onClick;
    onClick?.({
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
    });
  }

  it("assigns the href when the App Router never leaves /opening/today", () => {
    renderAndClick("/opening/assistant");
    expect(assign).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SHELL_NAV_FALLBACK_MS);
    expect(assign).toHaveBeenCalledWith("/opening/assistant");
  });

  it("cancels the watchdog once the soft navigation updates the path", () => {
    renderAndClick("/opening/library");
    pathname = "/opening/library";
    (window as unknown as { location: { pathname: string } }).location.pathname = "/opening/library";
    effects.length = 0;
    refIndex = 0;
    ShellNavLink({ href: "/opening/library", children: "笔记" });
    for (const effect of effects) effect();
    vi.advanceTimersByTime(SHELL_NAV_FALLBACK_MS);
    expect(assign).not.toHaveBeenCalled();
  });
});
