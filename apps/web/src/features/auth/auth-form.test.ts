import type { FormEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthForm } from "./auth-form";

const { replace, refresh, stateUpdates } = vi.hoisted(() => ({
  replace: vi.fn(), refresh: vi.fn(), stateUpdates: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));
// The unit suite has no DOM runtime; exercise the form's submit handler with hook state captured.
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const update = vi.fn();
    stateUpdates.push(update);
    return [initial, update];
  },
  useRef: (initial: unknown) => ({ current: initial }),
}));

const validInput = {
  displayName: "学习者", email: "learner@example.com", password: "test-password", confirmPassword: "test-password",
};

function submitEvent(input: Record<string, string> = validInput) {
  const focus = vi.fn();
  const namedItem = vi.fn(() => ({ focus }));
  vi.stubGlobal("FormData", class {
    get(name: string) { return input[name] ?? null; }
  });
  const event = { preventDefault: vi.fn(), currentTarget: { elements: { namedItem } } } as unknown as FormEvent<HTMLFormElement>;
  return { event, namedItem, focus };
}

beforeEach(() => {
  vi.useFakeTimers();
  stateUpdates.length = 0;
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("auth form submission", () => {
  it("never posts registration while registration is closed", async () => {
    const form = AuthForm({ mode: "register", registrationClosed: true });
    await form.props.onSubmit(submitEvent().event);
    expect(fetch).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("focuses the first invalid field in display order and keeps field errors", async () => {
    const form = AuthForm({ mode: "register" });
    const { event, namedItem, focus } = submitEvent({ displayName: "", email: "bad", password: "short", confirmPassword: "other" });
    await form.props.onSubmit(event);
    expect(stateUpdates[0]).toHaveBeenCalledWith({
      displayName: "请输入显示名称", email: "请输入有效的邮箱地址", password: "密码至少需要 8 个字符", confirmPassword: "两次输入的密码不一致",
    });
    expect(namedItem).toHaveBeenCalledWith("displayName");
    expect(focus).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts registration once while pending and continues to onboarding on success", async () => {
    let resolveRequest!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise(resolve => { resolveRequest = resolve; }));
    const form = AuthForm({ mode: "register" });
    const { event } = submitEvent();
    const pending = form.props.onSubmit(event);
    await form.props.onSubmit(event);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/auth/register", expect.objectContaining({
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: validInput.email, password: validInput.password, displayName: validInput.displayName }),
    }));
    expect(stateUpdates[2]).toHaveBeenCalledWith(true);
    resolveRequest({ ok: true } as Response);
    await pending;
    expect(replace).toHaveBeenCalledWith("/onboarding");
    expect(refresh).toHaveBeenCalledOnce();
    expect(stateUpdates[2]).toHaveBeenLastCalledWith(false);
  });

  it("preserves the server's error message and does not navigate", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({ error: { message: "该邮箱已注册" } }) } as Response);
    const form = AuthForm({ mode: "register" });
    await form.props.onSubmit(submitEvent().event);
    expect(stateUpdates[1]).toHaveBeenLastCalledWith("该邮箱已注册");
    expect(replace).not.toHaveBeenCalled();
  });

  it("explains network failure without exposing a technical fetch error and allows retry", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const form = AuthForm({ mode: "register" });
    const { event } = submitEvent();
    await form.props.onSubmit(event);
    expect(stateUpdates[1]).toHaveBeenLastCalledWith("无法连接到服务，请检查网络后重试");
    expect(stateUpdates[2]).toHaveBeenLastCalledWith(false);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
    await form.props.onSubmit(event);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith("/onboarding");
  });

  it("keeps login enabled and preserves its return destination", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    const form = AuthForm({ mode: "login", returnTo: "/library?course=c1#note", registrationClosed: true });
    await form.props.onSubmit(submitEvent().event);
    expect(fetch).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({
      body: JSON.stringify({ email: validInput.email, password: validInput.password }),
    }));
    expect(replace).toHaveBeenCalledWith("/library?course=c1#note");
  });

  it.each([
    ["login", "请求超时，请检查连接后重试"],
    ["register", "请求超时，账户可能已创建，请先尝试登录"],
  ] as const)("ends a stalled %s request after 20 seconds and allows a new submission", async (mode, message) => {
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const form = AuthForm({ mode });
    const { event } = submitEvent();
    const pending = form.props.onSubmit(event);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(stateUpdates[2]).toHaveBeenLastCalledWith(true);
    await form.props.onSubmit(event);
    expect(fetch).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(stateUpdates[2]).toHaveBeenLastCalledWith(false);
    expect(stateUpdates[1]).toHaveBeenLastCalledWith(message);
    expect(replace).not.toHaveBeenCalled();
    await pending;

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
    await form.props.onSubmit(event);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith(mode === "register" ? "/onboarding" : "/");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["login", "请求超时，请检查连接后重试"],
    ["register", "请求超时，账户可能已创建，请先尝试登录"],
  ] as const)("keeps the %s timeout active while reading an error response", async (mode, message) => {
    const json = vi.fn();
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
      json.mockImplementation(() => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      return { ok: false, json } as unknown as Response;
    });
    const form = AuthForm({ mode });
    const pending = form.props.onSubmit(submitEvent().event);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(json).toHaveBeenCalledOnce();
    expect(stateUpdates[1]).toHaveBeenLastCalledWith(message);
    expect(stateUpdates[2]).toHaveBeenLastCalledWith(false);
    expect(replace).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  });

  it("clears the deadline after a successful response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
    const form = AuthForm({ mode: "login" });
    await form.props.onSubmit(submitEvent().event);
    expect(replace).toHaveBeenCalledWith("/");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stateUpdates[1]).toHaveBeenLastCalledWith("");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the fallback for invalid JSON without leaving a timeout", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => { throw new SyntaxError("Invalid JSON"); } } as Response);
    const form = AuthForm({ mode: "login" });
    await form.props.onSubmit(submitEvent().event);
    expect(stateUpdates[1]).toHaveBeenLastCalledWith("暂时无法完成请求，请稍后重试");
    expect(stateUpdates[2]).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, { error: { message: "" } }, { error: { message: 123 } }])("uses a safe fallback for an invalid server error %j", async body => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => body } as Response);
    const form = AuthForm({ mode: "login" });
    await form.props.onSubmit(submitEvent().event);
    expect(stateUpdates[1]).toHaveBeenLastCalledWith("暂时无法完成请求，请稍后重试");
    expect(replace).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
