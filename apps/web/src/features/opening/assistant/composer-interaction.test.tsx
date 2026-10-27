// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer, type ComposerSubmit, type ComposerSubmitResult } from "./composer";
import { MessageList } from "./message-list";
import type { ComposerPurpose, TutorMode } from "@aistudy/contracts";

let host: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const send = () => act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
const undo = () => act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="撤回本轮选择，恢复自动判断"]')!.click(); });

it.each([false, true])("forces saved practice submissions and preserves retry/double-send protection (compact: %s)", async compact => {
  let finish!: (result: ComposerSubmitResult) => void;
  const first = new Promise<ComposerSubmitResult>(resolve => { finish = resolve; });
  const submit = vi.fn<(input: ComposerSubmit) => Promise<ComposerSubmitResult>>()
    .mockReturnValueOnce(first)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ accepted: true });
  await act(async () => root.render(<Composer compact={compact} practiceMode privacy="ephemeral"
    draft="给我一个提示" onDraftChange={() => undefined} onSubmit={submit} onPrivacyChange={() => undefined} />));
  expect(host.textContent).toContain("练习辅导会保存对话并记录帮助");
  expect(host.querySelector('[aria-label="隐私模式"]')).toBeNull();
  await act(async () => {
    const form = host.querySelector("form")!;
    for (let i = 0; i < 2; i++) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.calls[0]?.[0]).toMatchObject({ text: "给我一个提示", privacy: "saved" });
  await act(async () => finish({ accepted: false }));
  await send(); // Network failure must retain the same logical request too.
  await send();
  expect(submit).toHaveBeenCalledTimes(3);
  expect(submit.mock.calls[1]?.[0]).toEqual(submit.mock.calls[0]?.[0]);
  expect(submit.mock.calls[2]?.[0]).toEqual(submit.mock.calls[0]?.[0]);
  await send(); // An accepted send ends the retry chain.
  expect(submit).toHaveBeenCalledTimes(4);
  expect(submit.mock.lastCall?.[0].clientKey).not.toBe(submit.mock.calls[0]?.[0].clientKey);
  expect(submit.mock.lastCall?.[0].privacy).toBe("saved");
});

it("sends an ordinary question without required routing choices and leaves only attachment/send below the input", async () => {
  const submit = vi.fn<(input: ComposerSubmit) => Promise<ComposerSubmitResult>>().mockResolvedValue({ accepted: true });
  await act(async () => root.render(<Composer draft="请解释矩阵乘法" onDraftChange={() => undefined} onSubmit={submit} onContext={() => undefined} onPrivacyChange={() => undefined} />));
  const footer = host.querySelector('[aria-label="消息操作"]')!;
  expect(footer.querySelectorAll("button")).toHaveLength(2);
  expect(footer.querySelector("select,details")).toBeNull();
  await send();
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.calls[0]?.[0]).toMatchObject({ text: "请解释矩阵乘法", privacy: "saved" });
  expect(submit.mock.calls[0]?.[0]).not.toHaveProperty("mode");
  expect(submit.mock.calls[0]?.[0]).not.toHaveProperty("purpose");
  expect(submit.mock.calls[0]?.[0]).not.toHaveProperty("querySystem");
});

it("keeps an unconfirmed override retry stable, and undo returns to automatic routing with a new logical key", async () => {
  const submit = vi.fn<(input: ComposerSubmit) => Promise<ComposerSubmitResult>>().mockResolvedValue({ accepted: false });
  await act(async () => root.render(<Composer draft="解释这一题" modePrefill={{ mode: "hint", nonce: 1 }} purposePrefill={{ purpose: "answer", nonce: 1 }} onDraftChange={() => undefined} onSubmit={submit} />));
  expect(host.textContent).toContain("只给提示");
  await send(); await send();
  expect(submit.mock.calls[0]?.[0]).toMatchObject({ mode: "hint", purpose: "answer" });
  expect(submit.mock.calls[1]?.[0].clientKey).toBe(submit.mock.calls[0]?.[0].clientKey);
  await undo(); await send();
  expect(submit.mock.calls[2]?.[0]).not.toHaveProperty("mode");
  expect(submit.mock.calls[2]?.[0]).not.toHaveProperty("purpose");
  expect(submit.mock.calls[2]?.[0].clientKey).not.toBe(submit.mock.calls[1]?.[0].clientKey);
});

it.each(["send", "undo"])("does not resurrect a one-turn purpose after %s and a composer remount", async action => {
  const submit = vi.fn<(input: ComposerSubmit) => Promise<ComposerSubmitResult>>().mockResolvedValue({ accepted: true });
  function Parent({ version }: { version: number }) {
    const [purpose, setPurpose] = useState<{ purpose: ComposerPurpose; nonce: number } | null>({ purpose: "plan", nonce: 1 });
    return <Composer key={version} draft="帮我看看这道题" purposePrefill={purpose} onClearIntentOverride={() => setPurpose(null)} onDraftChange={() => undefined} onSubmit={submit} />;
  }
  await act(async () => root.render(<Parent version={0} />));
  expect(host.textContent).toContain("准备计划");
  if (action === "send") await send(); else await undo();
  await act(async () => root.render(<Parent version={1} />));
  expect(host.textContent).not.toContain("准备计划");
  await send();
  expect(submit.mock.lastCall?.[0]).not.toHaveProperty("purpose");
});

it("allows automatic record followups despite unavailable AI context, and never locks editing when records are disabled", async () => {
  const submit = vi.fn();
  const history = [{ role: "user", text: "我今天有哪些学习任务？" }];
  await act(async () => root.render(<Composer draft="那明天呢？" history={history} queryAvailable contextBlocked onDraftChange={() => undefined} onSubmit={submit} />));
  expect(host.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(false);
  await send();
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ text: "那明天呢？" }));
  expect(submit.mock.lastCall?.[0]).not.toHaveProperty("querySystem");
  await act(async () => root.render(<Composer draft="我的学习进度怎么样？" queryAvailable={false} contextBlocked onDraftChange={() => undefined} onSubmit={submit} />));
  expect(host.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(true);
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
  expect(host.textContent).toContain("学习记录暂时不可查询");
});

it("keeps privacy explicit and does not carry a saved-chat override into the temporary branch", async () => {
  const submit = vi.fn(), changePrivacy = vi.fn();
  const props = { draft: "解释这一步", modePrefill: { mode: "hint" as const, nonce: 1 }, onDraftChange() {}, onSubmit: submit, onPrivacyChange: changePrivacy };
  await act(async () => root.render(<Composer {...props} privacy="saved" />));
  const select = host.querySelector<HTMLSelectElement>('[aria-label="隐私模式"]')!;
  await act(async () => { select.value = "ephemeral"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(changePrivacy).toHaveBeenCalledExactlyOnceWith("ephemeral");
  await act(async () => root.render(<Composer {...props} privacy="ephemeral" />));
  expect(host.textContent).not.toContain("只给提示");
  await send();
  expect(submit.mock.lastCall?.[0]).toMatchObject({ privacy: "ephemeral" });
  expect(submit.mock.lastCall?.[0]).not.toHaveProperty("mode");
});

it("prepares a reversible reply-style choice without sending or overwriting the current question", async () => {
  const submit = vi.fn();
  function Parent() {
    const [mode, setMode] = useState<{ mode: TutorMode; nonce: number } | null>(null);
    return <><MessageList messages={[{ id: "reply", role: "assistant", text: "刚才的回答", status: "complete", citations: [], citationLabels: [] }]} artifactsEnabled={false} proseEnabled={false} onReplyMode={next => setMode({ mode: next, nonce: 1 })} />
      <Composer draft="保留我正在写的问题" modePrefill={mode} onClearIntentOverride={() => setMode(null)} onDraftChange={() => undefined} onSubmit={submit} /></>;
  }
  await act(async () => root.render(<Parent />));
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "我没懂")!.click());
  expect(submit).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留我正在写的问题");
  expect(host.querySelector('[aria-label="撤回本轮选择，恢复自动判断"]')).not.toBeNull();
  await undo(); await send();
  expect(submit.mock.lastCall?.[0]).not.toHaveProperty("mode");
});
