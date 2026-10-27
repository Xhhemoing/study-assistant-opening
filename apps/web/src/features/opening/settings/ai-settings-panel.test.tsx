// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS, type OpeningAiSettingsResponse } from "@aistudy/contracts";

const quickSetup = vi.hoisted(() => ({ configured: undefined as ((data: OpeningAiSettingsResponse) => void) | undefined }));
vi.mock("./quick-setup-panel", async importOriginal => {
  const actual = await importOriginal<typeof import("./quick-setup-panel")>();
  return { ...actual, QuickSetupPanel: (props: Parameters<typeof actual.QuickSetupPanel>[0]) => {
    quickSetup.configured = props.onConfigured;
    return <div data-quick-setup><actual.QuickSetupPanel {...props} /></div>;
  } };
});
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("./provider-settings-panel", () => ({ ProviderSettingsPanel: () => <div data-providers>自定义供应商表单</div> }));
import { AiSettingsPanel } from "./ai-settings-panel";

const base: OpeningAiSettingsResponse = {
  defaultModelId: "a", dailyCapCents: 0, dailyQuota: { mode: "unlimited" }, envCapCents: 0, personalCeilingCents: 2000,
  settings: DEFAULT_OPENING_AI_SETTINGS, saved: false, invalidStoredSettings: false,
  models: [{ id: "a", providerId: "one", providerLabel: "One", label: "Model A", modelName: "a", inputCentsPerMillion: 10, outputCentsPerMillion: 20, availability: "available" }],
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(data: OpeningAiSettingsResponse & { dailyUsage?: { localDate: string; timeZone: string; spentCents: number; reservedCents: number } | null }) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(data)));
  await act(async () => root.render(<AiSettingsPanel basePath="/opening/settings" />));
}
function overview() { return host.querySelector('[aria-label="当前模型与用量"]')!; }
async function changeBudget(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
async function fillQuickSetup() {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test-key");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function submitQuickSetup() { host.querySelector("#quick-model-setup form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
const writes = (method: string) => vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === method);

describe("AI settings overview and disclosure", () => {
  it("shows real usage outside a single closed disclosure containing all custom model controls", async () => {
    await render({ ...base, dailyUsage: { localDate: "2026-10-26", timeZone: "Asia/Shanghai", spentCents: 120, reservedCents: 40 } });
    expect(overview().textContent).toContain("服务器默认模型");
    expect(overview().textContent).toContain("One · Model A");
    expect(overview().textContent).toContain("今日已用 120 分");
    expect(overview().textContent).toContain("待结算预留 40 分");
    expect(overview().textContent).toContain("Asia/Shanghai");
    const details = host.querySelector<HTMLDetailsElement>('details[aria-labelledby="own-models-heading"]')!;
    expect(details.open).toBe(false);
    expect(details.querySelector("[data-quick-setup]")).not.toBeNull();
    expect(details.querySelector("[data-providers]")).not.toBeNull();
    expect(details.querySelector('[name="ai-routing-mode"]')).not.toBeNull();
    expect(host.querySelectorAll("#daily-budget")).toHaveLength(1);
    expect(host.textContent).toContain("测试期每日不限额");
    expect(host.textContent).not.toContain("日上限当前为 0");
  });

  it.each([undefined, null])("does not turn unknown usage into zero: %s", async dailyUsage => {
    await render({ ...base, dailyUsage });
    expect(overview().textContent).toContain("今日用量暂不可用");
    expect(overview().textContent).not.toContain("今日已用 0");
  });

  it("displays an actual zero and falls back to legacy limited quota metadata", async () => {
    await render({ ...base, dailyQuota: undefined, dailyCapCents: 200, envCapCents: 200, dailyUsage: { localDate: "2026-10-26", timeZone: "Asia/Shanghai", spentCents: 0, reservedCents: 0 } });
    expect(overview().textContent).toContain("今日已用 0 分");
    expect(overview().textContent).toContain("每日上限 200 分");
    expect(host.querySelector('input[type="number"]')).not.toBeNull();
  });

  it("does not call a custom selected model the server default", async () => {
    await render({ ...base, saved: true, settings: { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual", manualModelId: "custom" },
      models: [...base.models, { ...base.models[0]!, id: "custom", source: "workspace", label: "My Model" }] });
    expect(overview().textContent).toContain("当前模型");
    expect(overview().textContent).toContain("My Model");
    expect(overview().textContent).not.toContain("服务器默认模型");
  });

  it("retains the ability to lower a limited budget inside the disclosure", async () => {
    await render({ ...base, dailyQuota: { mode: "limited", capCents: 200 }, dailyCapCents: 200, envCapCents: 200 });
    host.querySelector<HTMLDetailsElement>('details[aria-labelledby="own-models-heading"]')!.open = true;
    await changeBudget("150");
    expect(button("保存模型设置").disabled).toBe(false);
    await act(async () => button("保存模型设置").click());
    const write = vi.mocked(fetch).mock.calls.find(call => call[1]?.method === "PUT")!;
    expect(JSON.parse(write[1]!.body as string)).toMatchObject({ dailyCapCents: 150 });
  });

  it("preserves explicit budget confirmation before saving an opt-in daily cap", async () => {
    await render({ ...base, dailyQuota: { mode: "limited", capCents: 0 } });
    await changeBudget("200");
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => button("确认开启每日额度").click());
    expect(host.textContent).not.toContain("已确认于");
    await act(async () => button("确认开启每日额度").click());
    expect(confirm).toHaveBeenCalledWith("确认开启每日 AI 额度？每天最多约 ¥2.00。确认后才会生效。");
    await act(async () => button("保存模型设置").click());
    const write = vi.mocked(fetch).mock.calls.find(call => call[1]?.method === "PUT")!;
    expect(JSON.parse(write[1]!.body as string)).toMatchObject({ dailyCapCents: 200, budgetConfirmedAt: expect.any(String) });
  });

  it("keeps unavailable and invalid settings visible while preserving reset", async () => {
    await render({ ...base, invalidStoredSettings: true, saved: true, models: [{ ...base.models[0]!, availability: "missing_key" }] });
    expect(overview().textContent).toContain("缺少服务器密钥");
    expect(overview().textContent).toContain("已保存的模型设置无效");
    const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "恢复服务器默认设置")!;
    expect(reset.disabled).toBe(false);
    await act(async () => reset.click());
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]).toMatchObject({ method: "PUT", body: "null" });
  });

  it("ignores an initial read that finishes after quick setup installs a new catalog", async () => {
    let resolveRead!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(resolve => { resolveRead = resolve; })));
    await act(async () => root.render(<AiSettingsPanel />));
    const configured = { ...base, models: [{ ...base.models[0]!, label: "New Model" }] };
    await act(async () => quickSetup.configured!(configured));
    expect(overview().textContent).toContain("New Model");
    await act(async () => resolveRead(Response.json(base)));
    expect(overview().textContent).toContain("New Model");
    expect(overview().textContent).not.toContain("Model A");
  });

  it("ignores a pending reread after quick setup and releases its busy state", async () => {
    await render(base);
    let resolveRead!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { resolveRead = resolve; }));
    await act(async () => button("重新读取模型设置").click());
    await act(async () => quickSetup.configured!({ ...base, models: [{ ...base.models[0]!, label: "New Model" }] }));
    expect(button("重新读取模型设置").disabled).toBe(false);
    await act(async () => resolveRead(Response.json(base)));
    expect(overview().textContent).toContain("New Model");
  });

  it("does not send quick setup while a save is pending, including the same render", async () => {
    await render({ ...base, dailyQuota: { mode: "limited", capCents: 200 }, dailyCapCents: 200, envCapCents: 200 });
    await changeBudget("150");
    await fillQuickSetup();
    let resolveSave!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSave = resolve; }));
    await act(async () => { button("保存模型设置").click(); submitQuickSetup(); });
    expect(writes("PUT")).toHaveLength(1);
    expect(writes("POST")).toHaveLength(0);
    expect(button("一键配置模型").disabled).toBe(true);
    await act(async () => resolveSave(Response.json(base)));
    await act(async () => submitQuickSetup());
    expect(writes("POST")).toHaveLength(1);
  });

  it("does not send save or reset while quick setup is pending", async () => {
    await render({ ...base, saved: true });
    await fillQuickSetup();
    let resolveSetup!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSetup = resolve; }));
    await act(async () => { submitQuickSetup(); button("恢复服务器默认设置").click(); });
    expect(writes("POST")).toHaveLength(1);
    expect(writes("PUT")).toHaveLength(0);
    expect(button("保存模型设置").disabled).toBe(true);
    expect(button("恢复服务器默认设置").disabled).toBe(true);
    await act(async () => resolveSetup(Response.json({ ...base, saved: true })));
    expect(button("恢复服务器默认设置").disabled).toBe(false);
  });

  it("retains the quick-setup lock after an unknown result and confirms the identical payload", async () => {
    await render({ ...base, saved: true });
    await fillQuickSetup();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network interrupted"));
    await act(async () => submitQuickSetup());
    const original = writes("POST")[0]![1]!.body;
    expect(button("恢复服务器默认设置").disabled).toBe(true);
    await act(async () => button("恢复服务器默认设置").click());
    expect(writes("PUT")).toHaveLength(0);
    await act(async () => button("确认上次配置结果").click());
    expect(writes("POST")[1]![1]!.body).toBe(original);
    expect(button("恢复服务器默认设置").disabled).toBe(false);
  });

  it("keeps all writes locked after an unknown save and never claims that a reread settles it", async () => {
    await render({ ...base, saved: true });
    await fillQuickSetup();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network interrupted"));
    await act(async () => button("恢复服务器默认设置").click());
    expect(host.textContent).toContain("保存结果尚未确认");
    expect(button("一键配置模型").disabled).toBe(true);
    expect(button("重新读取模型设置").disabled).toBe(true);
    await act(async () => submitQuickSetup());
    expect(writes("POST")).toHaveLength(0);
    expect(writes("PUT")).toHaveLength(1);
  });

  it("keeps an earlier unknown setup locked when its confirmation is rejected", async () => {
    await render({ ...base, saved: true });
    await fillQuickSetup();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network interrupted"));
    await act(async () => submitQuickSetup());
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "signed out" } }, { status: 401 }));
    await act(async () => button("确认上次配置结果").click());
    expect(button("恢复服务器默认设置").disabled).toBe(true);
    expect(button("确认上次配置结果")).toBeDefined();
    expect(writes("POST")[1]![1]!.body).toBe(writes("POST")[0]![1]!.body);
  });

  it("releases a definite setup rejection and keeps the existing routing draft", async () => {
    await render({ ...base, dailyQuota: { mode: "limited", capCents: 200 }, dailyCapCents: 200, envCapCents: 200 });
    await changeBudget("150");
    await fillQuickSetup();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "invalid" } }, { status: 422 }));
    await act(async () => submitQuickSetup());
    expect(button("保存模型设置").disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("150");
    await act(async () => button("保存模型设置").click());
    expect(writes("PUT")).toHaveLength(1);
  });

  it("releases a definite save rejection so quick setup can repair the configuration", async () => {
    await render({ ...base, saved: true });
    await fillQuickSetup();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "invalid" } }, { status: 422 }));
    await act(async () => button("恢复服务器默认设置").click());
    expect(button("一键配置模型").disabled).toBe(false);
    await act(async () => submitQuickSetup());
    expect(writes("POST")).toHaveLength(1);
  });
});
