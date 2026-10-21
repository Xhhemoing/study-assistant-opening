import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./auth-gate";
import { clearSessionExpiry, createSessionFetch } from "./session-expiry";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => unknown>, replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: hooks.replace }) }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: <T,>(initial: T) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = initial;
    return [hooks.slots[slot], (value: T) => { hooks.slots[slot] = value; }];
  },
  useRef: <T,>(initial: T) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial };
    return hooks.slots[slot];
  },
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));

let cleanups: Array<() => void>;
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
const child = createElement("textarea", { defaultValue: "尚未保存的答案" });
function render() {
  hooks.cursor = 0;
  hooks.effects.length = 0;
  return AuthGate({ children: child }) as ReactElement<{ children: ReactNode[] }>;
}
async function flush() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }
async function mount(response: Response = Response.json({ user: { id: "u1", workspaceId: "w1" } })) {
  transport.mockResolvedValueOnce(response);
  render();
  cleanups = hooks.effects.map(effect => effect()).filter((value): value is () => void => typeof value === "function");
  await flush();
}
function content(tree = render()) { return tree.props.children[1] as ReactElement<{ children: ReactNode; inert: boolean }>; }
function dialog(tree = render()) { return tree.props.children[0] as ReactElement<{ children: ReactElement<{ children: ReactNode[] }> | null; ref: { current: unknown }; onCancel: (event: { preventDefault: () => void }) => void }>; }
function recheckButton() {
  const notice = dialog().props.children!;
  return notice.props.children[2] as ReactElement<{ onClick: () => void }>;
}
async function expire() {
  await createSessionFetch(vi.fn(async () => Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 })))("/api/opening/today");
}

beforeEach(() => {
  hooks.slots.length = 0;
  hooks.effects.length = 0;
  hooks.cursor = 0;
  hooks.replace.mockClear();
  cleanups = [];
  transport = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", transport);
  const target = Object.assign(new EventTarget(), { location: new URL("https://study.example/opening/courses/c1?tab=units#q2") });
  Object.defineProperty(target, "fetch", { get: () => globalThis.fetch, set: value => { globalThis.fetch = value; } });
  vi.stubGlobal("window", target);
});
afterEach(() => { cleanups.forEach(cleanup => cleanup()); clearSessionExpiry(); vi.unstubAllGlobals(); });

describe("AuthGate session recovery", () => {
  it("installs global fetch before opening protected children and restores it on unmount", async () => {
    let authenticate!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise(resolve => { authenticate = resolve; }));
    expect(renderToStaticMarkup(render())).not.toContain("尚未保存的答案");
    cleanups = hooks.effects.map(effect => effect()).filter((value): value is () => void => typeof value === "function");
    expect(fetch).not.toBe(transport);
    authenticate(Response.json({ user: { id: "u1", workspaceId: "w1" } }));
    await flush();
    expect(content().props.children).toBe(child);
    transport.mockResolvedValueOnce(Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }));
    await fetch("/api/opening/conversations", { method: "POST" });
    expect(content().props.inert).toBe(true);
    cleanups.forEach(cleanup => cleanup());
    expect(fetch).toBe(transport);
  });

  it("retains the existing initial unauthenticated redirect with the exact return destination", async () => {
    await mount(new Response(null, { status: 401 }));
    expect(hooks.replace).toHaveBeenCalledWith("/login?returnTo=%2Fopening%2Fcourses%2Fc1%3Ftab%3Dunits%23q2");
  });

  it("keeps the same child in the same tree position when session expiry opens a login notice", async () => {
    await mount();
    const ready = render();
    expect(content(ready).props.children).toBe(child);
    expect(content(ready).props.inert).toBe(false);
    await expire();
    const expired = render();
    expect(content(expired).props.children).toBe(child);
    expect(content(expired).props.inert).toBe(true);
    expect(content(expired).type).toBe(content(ready).type);
    const modal = dialog(expired);
    const notice = modal.props.children!;
    const loginLink = notice.props.children[1] as ReactElement<{ ref: { current: unknown } }>;
    const focus = vi.fn();
    loginLink.props.ref.current = { focus };
    const nativeDialog = { open: false, showModal: vi.fn(), close: vi.fn() };
    modal.props.ref.current = nativeDialog;
    hooks.effects[1]?.();
    expect(nativeDialog.showModal).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    const preventDefault = vi.fn();
    modal.props.onCancel({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(expired);
    expect(html).toContain("尚未保存的答案");
    expect(html).toContain("登录已过期");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("returnTo=%2Fopening%2Fcourses%2Fc1%3Ftab%3Dunits%23q2");
    expect(hooks.replace).not.toHaveBeenCalled();
  });

  it("removes the notice after explicit revalidation without remounting or replaying any writes", async () => {
    await mount();
    await expire();
    transport.mockResolvedValueOnce(Response.json({ user: { id: "u1", workspaceId: "w1" } }));
    recheckButton().props.onClick();
    await flush();
    const ready = render();
    expect(dialog(ready).props.children).toBeNull();
    expect(content(ready).props.children).toBe(child);
    expect(content(ready).props.inert).toBe(false);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenLastCalledWith("/api/auth/me", { cache: "no-store" });
    expect(hooks.replace).not.toHaveBeenCalled();
    const closed = { open: true, close: vi.fn() };
    dialog(ready).props.ref.current = closed;
    hooks.effects[1]?.();
    expect(closed.close).toHaveBeenCalledOnce();
    await expire();
    expect(renderToStaticMarkup(render())).toContain("登录已过期");
  });

  it("keeps the child and an actionable notice if revalidation fails", async () => {
    await mount();
    await expire();
    transport.mockResolvedValueOnce(new Response(null, { status: 401 }));
    recheckButton().props.onClick();
    await flush();
    expect(renderToStaticMarkup(render())).toContain("请先在新标签页完成登录。");
    expect(content().props.children).toBe(child);
    expect(content().props.inert).toBe(true);
    expect(hooks.replace).not.toHaveBeenCalled();
  });

  it.each([
    { user: { id: "u2", workspaceId: "w1" } },
    { user: { id: "u1", workspaceId: "w2" } },
    { user: { workspaceId: "w1" } },
    { user: { id: "u1" } },
    {},
  ])("does not unlock another account, workspace or missing identity: %j", async identity => {
    await mount();
    await expire();
    transport.mockResolvedValueOnce(Response.json(identity));
    recheckButton().props.onClick();
    await flush();
    expect(renderToStaticMarkup(render())).toContain("请切回原账户和学习空间");
    expect(content().props.children).toBe(child);
    expect(content().props.inert).toBe(true);
    const callsBeforeWrite = transport.mock.calls.length;
    const response = await fetch("/api/opening/conversations", { method: "POST", body: "private draft" });
    expect(response.status).toBe(401);
    expect(transport).toHaveBeenCalledTimes(callsBeforeWrite);
    expect(hooks.replace).not.toHaveBeenCalled();
  });

  it("refuses to mount protected content when initial identity is missing", async () => {
    await mount(Response.json({ user: { displayName: "Missing identity" } }));
    const html = renderToStaticMarkup(render());
    expect(html).toContain("暂时无法验证登录账户");
    expect(html).not.toContain("尚未保存的答案");
  });
});
