import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Capture shell effects during SSR and replay them with a
 * persistent useState slot store so a second render reflects fetch outcomes.
 */
const effects: Array<() => unknown> = [];
const stateSlots: unknown[] = [];
let stateCall = 0;
let pathname = "/opening/today";
let search = "";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (fn: () => unknown) => {
      effects.push(fn);
    },
    useCallback: <T,>(fn: T) => fn,
    useState: <T,>(initial: T): [T, (value: T | ((prev: T) => T)) => void] => {
      const index = stateCall++;
      if (stateSlots[index] === undefined) stateSlots[index] = initial;
      const setState = (value: T | ((prev: T) => T)) => {
        stateSlots[index] = typeof value === "function" ? (value as (prev: T) => T)(stateSlots[index] as T) : value;
      };
      return [stateSlots[index] as T, setState];
    },
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children?: ReactNode; href: string }) =>
    createElement("a", { href, ...props }, children),
}));

vi.mock("../../search/command-palette", () => ({
  CommandPalette: () => null,
}));

vi.mock("./connection-notice", () => ({ ConnectionNotice: () => null }));

vi.mock("./focus-timer", () => ({
  FocusTimer: () => null,
}));
vi.mock("./mobile-navigation", () => ({
  OpeningMobileNavigation: () => null,
}));
vi.mock("../assistant/assistant-drawer", () => ({ AssistantDrawer: () => null }));
vi.mock("./account-menu", () => ({ OpeningAccountMenu: ({ pendingCount, focusMode }: { pendingCount: number | null; focusMode: boolean }) => createElement("button", { "aria-label": focusMode ? "退出专注模式" : "账户与学习工具" }, pendingCount ? createElement("span", { "aria-label": `${pendingCount} 项待审核` }, pendingCount) : null) }));
vi.mock("../inbox/citation-reader-host", () => ({ CitationReaderHost: () => null }));

import { OpeningShell } from "./opening-shell";

/** OpeningShell useState order after FocusTimer is mocked away. */
const PENDING_COUNT_SLOT = 5;
const FOCUS_MODE_SLOT = 4;

beforeEach(() => {
  effects.length = 0;
  stateSlots.length = 0;
  stateCall = 0;
  pathname = "/opening/today";
  search = "";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderShell() {
  stateCall = 0;
  effects.length = 0;
  return renderToStaticMarkup(createElement(OpeningShell, { children: createElement("div", null, "child") }));
}

async function runCapturedEffects() {
  for (const fn of effects) fn();
  // fetch().then(async () => { await response.json(); setState(...) }) needs several microtasks.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("OpeningShell review badge", () => {
  it("refreshes the badge after a decision on the current Today page", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", Object.assign(target, { localStorage: { getItem: () => null } }));
    let count = 2;
    vi.mocked(fetch).mockImplementation(async input => String(input).startsWith("/api/opening/reviews")
      ? Response.json({ total: count }) : Response.json({ user: { displayName: "学习者" } }));
    renderShell();
    await runCapturedEffects();
    expect(stateSlots[PENDING_COUNT_SLOT]).toBe(2);
    count = 1;
    target.dispatchEvent(new Event("opening:reviews-changed"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(stateSlots[PENDING_COUNT_SLOT]).toBe(1);
  });

  it("does not show the review badge when the reviews request fails", async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith("/api/opening/reviews")) throw new TypeError("Failed to fetch");
      if (url.startsWith("/api/auth/me")) {
        return Response.json({ user: { displayName: "学习者" } });
      }
      return new Response(null, { status: 404 });
    });

    expect(renderShell()).not.toContain("项待审核");
    expect(stateSlots[PENDING_COUNT_SLOT]).toBeNull();

    await runCapturedEffects();

    expect(stateSlots[PENDING_COUNT_SLOT]).toBeNull();
    const html = renderShell();
    expect(html).not.toContain("项待审核");
    expect(html).not.toContain("bg-amber-500");
    expect(html).toContain('aria-label="账户与学习工具"');
  });

  it("shows the review count badge only after a successful reviews response", async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input);
      if (url.startsWith("/api/opening/reviews")) return Response.json({ total: 3 });
      if (url.startsWith("/api/auth/me")) return Response.json({ user: { displayName: "学习者" } });
      return new Response(null, { status: 404 });
    });

    renderShell();
    await runCapturedEffects();
    expect(stateSlots[PENDING_COUNT_SLOT]).toBe(3);

    const html = renderShell();
    expect(html).toContain('aria-label="3 项待审核"');

  });

  it("clears a previous count when the next route cannot refresh suggestions", async () => {
    vi.mocked(fetch).mockImplementation(async input => String(input).startsWith("/api/opening/reviews")
      ? Response.json({ total: 3 })
      : Response.json({ user: { displayName: "学习者" } }));
    renderShell();
    await runCapturedEffects();
    expect(stateSlots[PENDING_COUNT_SLOT]).toBe(3);
    pathname = "/opening/courses";
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    renderShell();
    await runCapturedEffects();
    expect(stateSlots[PENDING_COUNT_SLOT]).toBeNull();
    expect(renderShell()).not.toContain('aria-label="3 项待审核"');
  });
});

describe("OpeningShell focus mode keyboard exit", () => {
  let keyboardTarget: EventTarget;
  const querySelector = vi.fn();

  beforeEach(() => {
    keyboardTarget = new EventTarget();
    vi.stubGlobal("window", Object.assign(keyboardTarget, { localStorage: { getItem: () => null } }));
    vi.stubGlobal("document", { querySelector });
    querySelector.mockReturnValue(null);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
    stateSlots[FOCUS_MODE_SLOT] = true;
  });

  function pressEscape(prevented = false, composing: { isComposing?: boolean; keyCode?: number } = {}) {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperty(event, "key", { value: "Escape" });
    Object.defineProperties(event, Object.fromEntries(Object.entries(composing).map(([key, value]) => [key, { value }])));
    if (prevented) event.preventDefault();
    keyboardTarget.dispatchEvent(event);
  }

  it("exits focus mode with Escape", async () => {
    renderShell();
    await runCapturedEffects();
    pressEscape();
    expect(stateSlots[FOCUS_MODE_SLOT]).toBe(false);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("keeps focus while Escape cancels IME composition: %j", async composing => {
    renderShell();
    await runCapturedEffects();
    pressEscape(false, composing);
    expect(stateSlots[FOCUS_MODE_SLOT]).toBe(true);
  });

  it("leaves Escape to an open native dialog", async () => {
    querySelector.mockReturnValue({ open: true });
    renderShell();
    await runCapturedEffects();
    pressEscape();
    expect(stateSlots[FOCUS_MODE_SLOT]).toBe(true);
  });

  it("keeps focus mode when a panel has already handled Escape", async () => {
    renderShell();
    await runCapturedEffects();
    pressEscape(true);
    expect(stateSlots[FOCUS_MODE_SLOT]).toBe(true);
  });

  it("removes its keyboard handler when focus mode ends", async () => {
    renderShell();
    const cleanups = effects.map(effect => effect());
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    pressEscape();
    expect(stateSlots[FOCUS_MODE_SLOT]).toBe(true);
  });
});

describe("course study focus layout", () => {
  it("keeps navigation available when opening or switching a lesson", () => {
    pathname = "/opening/courses/course-a/study";
    expect(renderShell()).toContain('data-focus="false"');
    pathname = "/opening/courses/course-b/study";
    expect(renderShell()).toContain('data-focus="false"');
  });

  it("retains an explicit focus choice until Escape without changing the lesson", async () => {
    pathname = "/opening/courses/course-a/study";
    stateSlots[FOCUS_MODE_SLOT] = true;
    const target = new EventTarget();
    vi.stubGlobal("window", Object.assign(target, { localStorage: { getItem: () => null } }));
    vi.stubGlobal("document", { querySelector: () => null });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
    expect(renderShell()).toContain('data-focus="true"');
    await runCapturedEffects();
    const event = new Event("keydown");
    Object.defineProperty(event, "key", { value: "Escape" });
    target.dispatchEvent(event);
    expect(renderShell()).toContain('data-focus="false"');
    expect(pathname).toBe("/opening/courses/course-a/study");
  });
});

describe("shared-page navigation", () => {
  it.each([
    ["/opening/review", "tab=cards", "/opening/cards"],
    ["/opening/courses/course-a", "mode=sprint", "/opening/sprint"],
  ])("reads the current query at %s", (path, query, expected) => {
    pathname = path; search = query;
    const html = renderShell();
    const selected = [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)].map(match => match[0]);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain(`href="${expected}"`);
  });
});
