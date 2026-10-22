// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceRecord, UploadTicket } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { Composer, type ComposerSubmit } from "../assistant/composer";
import { StartUploads } from "./start-uploads";

const upload = vi.hoisted(() => vi.fn());
vi.mock("../inbox/upload-client", () => ({ createUploadClient: () => ({ uploadFile: upload }) }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); upload.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("retains a failed photo and text, blocks incomplete attachment sends, and resumes the same saved source on retry", async () => {
  const source = { id: "source-id", name: "题目.jpg", mime: "image/jpeg", version: 1, uploadState: "uploaded", parseState: "ready" } as SourceRecord;
  const ticket = { source } as UploadTicket;
  upload.mockResolvedValueOnce({ phase: "interrupted", ticket, keptLocal: true, message: "网络中断，原件还在" }).mockResolvedValueOnce(source);
  const submitted = vi.fn<(input: ComposerSubmit) => Promise<{ accepted: boolean }>>(async () => ({ accepted: false }));
  const uploaded = vi.fn(async () => undefined);
  const api = {} as OpeningApi;
  function Parent() {
    const [blocked, setBlocked] = useState(false);
    return <Composer questionMode startMode draft="请保留我的问题" sendDisabled={blocked} onDraftChange={() => undefined} onSubmit={submitted}
      attachments={<StartUploads api={api} sources={[]} courseId={null} onBusyChange={setBlocked} onUploaded={uploaded} />} />;
  }
  await act(async () => root.render(<Parent />));
  const camera = host.querySelector<HTMLInputElement>('input[capture="environment"]')!;
  const file = new File(["photo"], "题目.jpg", { type: "image/jpeg" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2]).buffer });
  Object.defineProperty(camera, "files", { value: [file], configurable: true });
  await act(async () => camera.dispatchEvent(new Event("change", { bubbles: true })));
  expect(host.textContent).toContain("网络中断，原件还在");
  expect(host.textContent).toContain("题目.jpg");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("请保留我的问题");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(true);
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(submitted).not.toHaveBeenCalled();
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "重试")!.click());
  expect(upload).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls[1]?.[1]).toMatchObject({ resumeSourceId: "source-id", ticket });
  expect(uploaded).toHaveBeenCalledExactlyOnceWith(["source-id"], [source]);
  expect(host.querySelector('a[href="/opening/practice?sourceId=source-id"]')?.textContent).toBe("开始作答");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(false);
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(submitted).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("请保留我的问题");
});

it("ignores Enter during composition and keyCode 229, and retains the logical send key after a failed question", async () => {
  const submitted = vi.fn<(input: ComposerSubmit) => Promise<{ accepted: boolean }>>(async () => ({ accepted: false }));
  await act(async () => root.render(<Composer questionMode draft="我的问题" onDraftChange={() => undefined} onSubmit={submitted} />));
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  });
  expect(submitted).not.toHaveBeenCalled();
  await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(submitted).toHaveBeenCalledTimes(2);
  expect(submitted.mock.calls[0]?.[0]).toMatchObject({ text: "我的问题" });
  expect(submitted.mock.calls[1]?.[0]).toEqual(submitted.mock.calls[0]?.[0]);
});
