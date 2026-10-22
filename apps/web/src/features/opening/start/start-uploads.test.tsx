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

function selectableFile(name: string, type = "application/pdf", size = 4) {
  const file = new File(["file"], name, { type });
  const read = vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer);
  Object.defineProperties(file, { arrayBuffer: { value: read }, size: { value: size } });
  return { file, read };
}

async function selectFiles(selected: File[]) {
  const picker = host.querySelector<HTMLInputElement>('input[multiple]')!;
  Object.defineProperty(picker, "files", { value: selected, configurable: true });
  await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
}

it.each([
  { name: "photo.heic", type: "image/heic", size: 4, reason: "不支持的文件类型" },
  { name: "empty.txt", type: "text/plain", size: 0, reason: "为空" },
  { name: "large.png", type: "image/png", size: 20 * 1024 * 1024 + 1, reason: "超过此格式的大小限制" },
  { name: "../notes.pdf", type: "application/pdf", size: 4, reason: "请重命名" },
])("rejects $name before reading bytes or starting an upload", async ({ name, type, size, reason }) => {
  const busy = vi.fn();
  await act(async () => root.render(<StartUploads api={{} as OpeningApi} sources={[]} courseId={null} onBusyChange={busy} onUploaded={async () => undefined} />));
  const { file, read } = selectableFile(name, type, size);
  await selectFiles([file]);
  expect(read).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(busy).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(reason);
});

it("rejects excessive selections before reading any file", async () => {
  await act(async () => root.render(<StartUploads api={{} as OpeningApi} sources={[]} courseId={null} onBusyChange={() => undefined} onUploaded={async () => undefined} />));
  const selected = Array.from({ length: 21 }, (_, index) => selectableFile(`${index}.pdf`));
  await selectFiles(selected.map(item => item.file));
  expect(selected.every(item => item.read.mock.calls.length === 0)).toBe(true);
  expect(host.textContent).toContain("最多 20 份");
  const videos = [selectableFile("one.mp4", "video/mp4", 300 * 1024 * 1024), selectableFile("two.mp4", "video/mp4", 300 * 1024 * 1024)];
  await selectFiles(videos.map(item => item.file));
  expect(videos.every(item => item.read.mock.calls.length === 0)).toBe(true);
  expect(host.textContent).toContain("总大小不能超过 512 MiB");
  expect(upload).not.toHaveBeenCalled();
});

it("waits for the first upload before reading the next file", async () => {
  const source = { id: "first", name: "first.pdf", mime: "application/pdf", uploadState: "uploaded", parseState: "queued" } as SourceRecord;
  let finish!: (value: SourceRecord) => void;
  upload.mockImplementationOnce(() => new Promise<SourceRecord>(resolve => { finish = resolve; })).mockResolvedValueOnce({ ...source, id: "second" });
  await act(async () => root.render(<StartUploads api={{} as OpeningApi} sources={[]} courseId={null} onBusyChange={() => undefined} onUploaded={async () => undefined} />));
  const first = selectableFile("first.pdf"), second = selectableFile("second.pdf");
  await selectFiles([first.file, second.file]);
  expect(first.read).toHaveBeenCalledOnce();
  expect(upload).toHaveBeenCalledOnce();
  expect(second.read).not.toHaveBeenCalled();
  await act(async () => finish(source));
  expect(second.read).toHaveBeenCalledOnce();
  expect(upload).toHaveBeenCalledTimes(2);
});

it("retries only unread files after a read failure without uploading an earlier saved file twice", async () => {
  const source = { id: "first", name: "first.pdf", mime: "application/pdf", uploadState: "uploaded", parseState: "queued" } as SourceRecord;
  upload.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, id: "second", name: "second.pdf" });
  const uploaded = vi.fn(async () => undefined), busy = vi.fn();
  await act(async () => root.render(<StartUploads api={{} as OpeningApi} sources={[]} courseId={null} onBusyChange={busy} onUploaded={uploaded} />));
  const first = selectableFile("first.pdf"), second = selectableFile("second.pdf");
  second.read.mockRejectedValueOnce(new Error("disk read failed"));
  await selectFiles([first.file, second.file]);
  expect(upload).toHaveBeenCalledOnce();
  expect(uploaded).toHaveBeenCalledExactlyOnceWith(["first"], [source]);
  expect(host.textContent).toContain("无法读取文件「second.pdf」");
  expect(busy).toHaveBeenLastCalledWith(true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="移除上传记录 first.pdf"]')!.click());
  expect(busy).toHaveBeenLastCalledWith(true);
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "重试")!.click());
  expect(first.read).toHaveBeenCalledOnce();
  expect(second.read).toHaveBeenCalledTimes(2);
  expect(upload).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls.map(call => call[0].name)).toEqual(["first.pdf", "second.pdf"]);
  expect(busy).toHaveBeenLastCalledWith(false);
});
