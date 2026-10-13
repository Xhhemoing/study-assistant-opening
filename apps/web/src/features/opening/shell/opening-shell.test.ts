import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * No DOM library is installed. Capture effects during SSR and replay them with a
 * persistent useState slot store so a second render reflects fetch outcomes.
 */
const effects: Array<() => unknown> = [];
const stateSlots: unknown[] = [];
let stateCall = 0;

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
  usePathname: () => "/opening/today",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children?: ReactNode; href: string }) =>
    createElement("a", { href, ...props }, children),
}));

vi.mock("../../search/command-palette", () => ({
  CommandPalette: () => null,
}));

vi.mock("./focus-timer", () => ({
  FocusTimer: () => null,
}));

import { OpeningShell } from "./opening-shell";

/** OpeningShell useState order after FocusTimer is mocked away. */
const PENDING_COUNT_SLOT = 5;

beforeEach(() => {
  effects.length = 0;
  stateSlots.length = 0;
  stateCall = 0;
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
    expect(html).toContain('aria-label="待确认建议"');
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
    expect(html).toContain("bg-amber-500");
  });
});
