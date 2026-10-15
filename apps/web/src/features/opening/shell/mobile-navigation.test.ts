import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const effects: Array<() => unknown> = [];
const refs: Array<{ current: unknown }> = [];
let refIndex = 0;
let expanded = false;

vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => unknown) => { effects.push(effect); },
  useRef: (initial: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
  useState: () => [expanded, (value: boolean) => { expanded = value; }],
}));
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode; href: string }) => createElement("a", props, children) }));

import { OpeningMobileNavigation } from "./mobile-navigation";

type ControlProps = {
  children?: ReactNode;
  href?: string;
  "aria-label"?: string;
  "aria-haspopup"?: string;
  "aria-current"?: string;
  "aria-expanded"?: boolean;
  onClick?: () => void;
  onCancel?: (event: { preventDefault: () => void }) => void;
};

function findControl(node: ReactNode, match: (control: ReactElement<ControlProps>) => boolean): ReactElement<ControlProps> | undefined {
  if (Array.isArray(node)) return node.map(child => findControl(child, match)).find(Boolean);
  if (!isValidElement<ControlProps>(node)) return;
  return match(node) ? node : findControl(node.props.children, match);
}

const dialog = { open: false, showModal: vi.fn(), close: vi.fn() };
let desktop: EventTarget & { matches: boolean };

function renderNavigation(pathname = "/opening/today", pendingCount: number | null = null) {
  effects.length = 0;
  refIndex = 0;
  const tree = OpeningMobileNavigation({ pathname, pendingCount });
  refs[0].current = dialog;
  return tree;
}

beforeEach(() => {
  expanded = false;
  refs.length = 0;
  dialog.open = false;
  dialog.showModal.mockImplementation(() => { dialog.open = true; });
  dialog.close.mockImplementation(() => { dialog.open = false; });
  desktop = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("window", { matchMedia: () => desktop });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Opening mobile navigation", () => {
  it("puts four core links and More in the bottom nav, with secondary links in a native dialog", () => {
    const tree = renderNavigation();
    const bottomNav = findControl(tree, control => control.props["aria-label"] === "学习工作台导航（移动端）");
    const html = renderToStaticMarkup(bottomNav);
    expect(html.match(/<a /g)).toHaveLength(4);
    expect(html).toContain("更多");
    expect(html).not.toContain('/opening/cards');
    const moreDialog = findControl(tree, control => control.type === "dialog");
    const dialogHtml = renderToStaticMarkup(moreDialog);
    expect(dialogHtml).toContain('/opening/cards');
    expect(dialogHtml).toContain('/opening/review');
    expect(dialogHtml).toContain('/opening/settings/connections');
  });

  it("marks More active on a secondary page and retains the review count in its dialog", () => {
    const tree = renderNavigation("/opening/cards/session", 3);
    const more = findControl(tree, control => control.props["aria-haspopup"] === "dialog");
    expect(more?.props["aria-current"]).toBe("page");
    expect(renderToStaticMarkup(tree)).toContain('aria-label="3 项待审核"');
  });

  it("opens with showModal and closes through the native cancel event", () => {
    let tree = renderNavigation();
    findControl(tree, control => control.props["aria-haspopup"] === "dialog")?.props.onClick?.();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    tree = renderNavigation();
    expect(findControl(tree, control => control.props["aria-haspopup"] === "dialog")?.props["aria-expanded"]).toBe(true);
    const preventDefault = vi.fn();
    findControl(tree, control => control.type === "dialog")?.props.onCancel?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);
    expect(expanded).toBe(false);
  });

  it("dismisses after selecting a secondary link, on route changes, and on desktop resize", () => {
    let tree = renderNavigation();
    findControl(tree, control => control.props["aria-haspopup"] === "dialog")?.props.onClick?.();
    findControl(tree, control => control.props.href === "/opening/cards")?.props.onClick?.();
    expect(dialog.open).toBe(false);
    dialog.open = true;
    expanded = true;
    tree = renderNavigation("/opening/review");
    effects[0]();
    expect(dialog.open).toBe(false);
    const cleanup = effects[1]();
    dialog.open = true;
    expanded = true;
    desktop.matches = true;
    desktop.dispatchEvent(new Event("change"));
    expect(dialog.open).toBe(false);
    expect(expanded).toBe(false);
    if (typeof cleanup === "function") cleanup();
  });
});
