// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { materialImportBindingInputSchema } from "@aistudy/contracts";
import { MaterialMappingDraft } from "./material-mapping-draft";
import type { MappingDraftMetadata } from "./material-mapping-draft-model";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const metadata = (): MappingDraftMetadata => ({
  actorKey: "synthetic-author", inputResetKey: "reset-1", sourceId: uuid(1), sourceVersion: 2,
  sourceSha256: "a".repeat(64), expectedManifestRevision: 3, mappingId: uuid(2), questionId: uuid(3),
  questionContentVersion: 0, answerContentVersion: 1,
  chunks: [{ chunkId: uuid(4), physicalPage: 8, printedLabel: "iv / exercise 99", textLength: 100 },
    { chunkId: uuid(5), physicalPage: null, printedLabel: null, textLength: 80 }],
});
let host: HTMLDivElement, root: Root;
const onDraft = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); onDraft.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function mount(input: unknown = metadata()) { act(() => root.render(createElement(MaterialMappingDraft, { input, onDraft }))); }
function control<T extends HTMLElement = HTMLInputElement>(label: string): T {
  const node = [...host.querySelectorAll("label")].find(item => item.textContent === label)!;
  return (node.htmlFor ? document.getElementById(node.htmlFor) : node.querySelector("input")) as unknown as T;
}
function enter(label: string, value: string) {
  const node = control<HTMLInputElement | HTMLTextAreaElement>(label);
  act(() => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function select(label: string, value: string) {
  const node = control<HTMLSelectElement>(label);
  act(() => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
}
function button(label = "交出本地草稿") { return [...host.querySelectorAll("button")].find(node => node.textContent === label)!; }
function click(node: HTMLElement) { act(() => node.click()); }
function confirm() { click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!); }
function locations(question = uuid(4), answer = uuid(5)) {
  select("题目来源片段", question); select("答案来源片段", answer);
  enter("题目起点（UTF-16，含）", "0"); enter("题目终点（UTF-16，不含）", "20");
  enter("答案起点（UTF-16，含）", "20"); enter("答案终点（UTF-16，不含）", "30");
}
function texts() { enter("题目正文（人工转录）", "求 1 + 1\n"); enter("答案正文（人工转录）", "PRIVATE_SYNTHETIC_ANSWER_2\n"); }
function complete() { locations(); texts(); confirm(); }
function values() { return [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=checkbox]),textarea")].map(node => node.value); }

describe("manual author-only local draft", () => {
  it("requires manual entry AND explicit confirmation, sends a complete parsed private draft exactly once", () => {
    mount(); expect(onDraft).not.toHaveBeenCalled(); expect(button().disabled).toBe(true);
    locations(); texts(); expect(button().disabled).toBe(true); confirm(); expect(button().disabled).toBe(false);
    expect(onDraft).not.toHaveBeenCalled(); click(button()); click(button()); expect(onDraft).toHaveBeenCalledTimes(1);
    const draft: unknown = onDraft.mock.calls[0]![0]; expect(materialImportBindingInputSchema.safeParse(draft).success).toBe(true);
    expect(draft).toMatchObject({ sourceId: uuid(1), sourceVersion: 2, sourceSha256: "a".repeat(64), expectedManifestRevision: 3,
      question: { content: { stem: "求 1 + 1\n", contentVersion: 0, interaction: { kind: "numeric" } }, locator: { physicalPage: 8, printedLabel: "iv / exercise 99" } },
      answer: { content: { text: "PRIVATE_SYNTHETIC_ANSWER_2\n", contentVersion: 1, role: "answer_key" }, locator: { physicalPage: null, printedLabel: null } },
      manualConfirmation: { method: "manual_transcription", confirmed: true } });
    expect(Object.keys(draft as object).sort()).toEqual(["schemaVersion", "sourceId", "sourceVersion", "sourceSha256", "expectedManifestRevision", "mappingId", "questionId", "question", "answer", "manualConfirmation"].sort());
    expect(host.querySelector('[role="status"]')!.textContent).toContain("尚未保存或发布");
  });

  it("distinguishes physical page from printed label and never derives page from exercise number", () => {
    mount(); locations(); texts(); confirm(); click(button());
    expect(host.textContent).toContain("两者不互相替代"); expect(host.textContent).toContain("未知（文本片段或未提供）");
    expect(onDraft.mock.calls[0]![0].question.locator.physicalPage).toBe(8);
    expect(onDraft.mock.calls[0]![0].answer.locator.physicalPage).toBeNull();
  });

  it("accepts touching ranges in the same chunk, rejects overlap", () => {
    mount(); locations(uuid(4), uuid(4)); texts(); confirm(); expect(button().disabled).toBe(false);
    enter("答案起点（UTF-16，含）", "19"); texts(); confirm(); expect(button().disabled).toBe(true);
    click(button()); expect(onDraft).not.toHaveBeenCalled();
  });

  it.each(["", " ", "\ud800"])("rejects invalid/incomplete question %j without an error echo", stem => {
    mount(); locations(); texts(); enter("题目正文（人工转录）", stem); confirm();
    expect(button().disabled).toBe(true); click(button()); expect(onDraft).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it.each(["", " ", "\ud800"])("rejects invalid/incomplete answer %j", answer => {
    mount(); locations(); texts(); enter("答案正文（人工转录）", answer); confirm();
    expect(button().disabled).toBe(true); expect(onDraft).not.toHaveBeenCalled();
  });
  it.each(["", "-1", "1.5", "1e1", "0x10", "01", "101", "9007199254740993"])("rejects malformed/out-of-bounds range %j", end => {
    mount(); locations(); enter("题目终点（UTF-16，不含）", end); texts(); confirm();
    expect(button().disabled).toBe(true); click(button()); expect(onDraft).not.toHaveBeenCalled();
  });
  it("rejects reversed and empty ranges", () => {
    mount(); locations(); enter("题目起点（UTF-16，含）", "20"); texts(); confirm(); expect(button().disabled).toBe(true);
    enter("题目起点（UTF-16，含）", "21"); texts(); confirm(); expect(button().disabled).toBe(true);
  });
  it("does not select or invent a missing/unknown chunk", () => {
    mount(); texts(); confirm(); expect(button().disabled).toBe(true);
    locations(); select("答案来源片段", uuid(99)); texts(); confirm(); expect(button().disabled).toBe(true); expect(onDraft).not.toHaveBeenCalled();
  });
  it("supports manual choice options but rejects duplicate IDs and incomplete options", () => {
    mount(); locations(); texts(); select("作答方式", "choice"); confirm(); expect(button().disabled).toBe(true);
    enter("选项 1 编号", "A"); enter("选项 1 正文", "2"); enter("选项 2 编号", "A"); enter("选项 2 正文", "3"); confirm();
    expect(button().disabled).toBe(true); enter("选项 2 编号", "B"); confirm(); expect(button().disabled).toBe(false);
    click(button()); expect(onDraft.mock.calls[0]![0].question.content.interaction).toEqual({ kind: "choice", options: [{ id: "A", label: "2" }, { id: "B", label: "3" }] });
  });
  it("bounds option addition/removal and preserves explicit numeric unit", () => {
    mount(); locations(); texts(); enter("单位（可不填）", "米"); confirm(); click(button());
    expect(onDraft.mock.calls[0]![0].question.content.interaction).toEqual({ kind: "numeric", unit: "米" });
    select("作答方式", "choice"); expect(button("移除末项").disabled).toBe(true);
    for (let i = 0; i < 5; i++) click(button("添加选项"));
    expect(button("添加选项").disabled).toBe(true); expect(host.querySelectorAll('fieldset input[maxlength="20"]')).toHaveLength(6);
    click(button("移除末项")); expect(button("添加选项").disabled).toBe(false);
  });
  it("any content edit revokes confirmation; locator edits also discard both transcriptions", () => {
    mount(); complete(); enter("单位（可不填）", "m"); expect(button().disabled).toBe(true);
    confirm(); enter("答案终点（UTF-16，不含）", "31");
    expect(control<HTMLTextAreaElement>("答案正文（人工转录）").value).toBe("");
    expect(control<HTMLTextAreaElement>("题目正文（人工转录）").value).toBe(""); expect(button().disabled).toBe(true);
    texts(); confirm(); select("题目来源片段", uuid(5)); expect(values().every(value => value === "")).toBe(true);
  });
  it("locator range change also clears old choice options and unit, not just the answer text", () => {
    mount(); complete(); select("作答方式", "choice");
    enter("选项 1 编号", "A"); enter("选项 1 正文", "PRIVATE_OLD_OPTION");
    enter("答案终点（UTF-16，不含）", "32");
    expect(control<HTMLSelectElement>("作答方式").value).toBe("numeric");
    expect(control<HTMLInputElement>("单位（可不填）").value).toBe("");
    expect(host.innerHTML).not.toContain("PRIVATE_OLD_OPTION"); expect(button().disabled).toBe(true);
  });
  it.each(["取消草稿", "重置草稿"])("%s clears without callback or storage", label => {
    mount(); complete(); click(button(label)); expect(values().every(value => value === "")).toBe(true);
    expect(control<HTMLSelectElement>("题目来源片段").value).toBe("");
    expect(button().disabled).toBe(true); expect(onDraft).not.toHaveBeenCalled();
  });

  it.each([
    { sourceId: uuid(9) }, { sourceVersion: 3 }, { sourceSha256: "b".repeat(64) },
    { actorKey: "different-author" }, { inputResetKey: "reset-2" }, { mappingId: uuid(9) }, { questionId: uuid(9) },
    { expectedManifestRevision: 4 }, { questionContentVersion: 1 }, { answerContentVersion: 2 },
    { chunks: [{ chunkId: uuid(4), physicalPage: 9, printedLabel: "new label", textLength: 99 }] },
  ])("binding/actor/reset changes destroy stale draft: %j", patch => {
    const input = metadata(); mount(input); complete(); mount({ ...input, ...patch });
    expect(values().every(value => value === "")).toBe(true); expect(button().disabled).toBe(true); expect(onDraft).not.toHaveBeenCalled();
  });
  it("equivalent metadata rerender is not an implicit input reset", () => {
    mount(); complete(); mount(metadata()); expect(button().disabled).toBe(false); expect(onDraft).not.toHaveBeenCalled();
  });

  it.each([
    null, {}, { ...metadata(), sourceSha256: "PRIVATE_INVALID_SHA_CANARY" },
    { ...metadata(), rawAnswer: "PRIVATE_RAW_CANARY" }, { ...metadata(), sourceVersion: -1 },
    { ...metadata(), chunks: [{ chunkId: "PRIVATE_CHUNK_CANARY", physicalPage: 0, printedLabel: "PRIVATE_LABEL_CANARY", textLength: 10 }] },
    { ...metadata(), chunks: [metadata().chunks[0], metadata().chunks[0]] },
  ])("invalid metadata closes without private raw or errors echoed", input => {
    mount(); complete(); mount(input); expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelectorAll("input,textarea,select,button")).toHaveLength(0);
    expect(host.innerHTML).not.toMatch(/PRIVATE_|Zod|sourceSha256|rawAnswer/); expect(onDraft).not.toHaveBeenCalled();
    mount(); expect(values().every(value => value === "")).toBe(true);
  });
  it.each([
    { nested: false, throws: false }, { nested: false, throws: true },
    { nested: true, throws: false }, { nested: true, throws: true },
  ])("accessor metadata closes and destroys old editor without evaluation or private errors: %j", ({ nested, throws }) => {
    mount(); complete(); const stale = button(); const input = metadata(); let reads = 0;
    Object.defineProperty(nested ? input.chunks[0]! : input, nested ? "printedLabel" : "actorKey", {
      enumerable: true, get() { reads++; if (throws) throw new Error("PRIVATE_RENDER_ERROR_CANARY"); return "PRIVATE_METADATA_VALUE_CANARY"; },
    });
    expect(() => mount(input)).not.toThrow(); click(stale);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("资料信息不完整或不可用，无法编辑。请联系资料负责人。");
    expect(host.querySelectorAll("input,textarea,select,button")).toHaveLength(0);
    expect(host.innerHTML).not.toMatch(/PRIVATE_|Zod|sourceSha256|actorKey/);
    expect(reads).toBe(0); expect(onDraft).not.toHaveBeenCalled();
    mount(); expect(values().every(value => value === "")).toBe(true); expect(button().disabled).toBe(true);
  });
  it("renders and binds the last of 1000 legal chunks without truncation", () => {
    const input = metadata(); input.chunks = Array.from({ length: 1000 }, (_, i) => ({ chunkId: uuid(i + 4), physicalPage: i + 1, printedLabel: "p".repeat(120), textLength: 100 }));
    mount(input); expect(control<HTMLSelectElement>("题目来源片段").options).toHaveLength(1001);
    locations(uuid(1003), uuid(1003)); texts(); confirm(); expect(button().disabled).toBe(false); click(button());
    expect(onDraft).toHaveBeenCalledTimes(1); expect(onDraft.mock.calls[0]![0].question.locator.chunkId).toBe(uuid(1003));
  });
  it("keeps canaries private to the author draft, performs no network/storage/submit and no side effects on mount/edit", () => {
    const fetch = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", fetch);
    const storage = vi.spyOn(Storage.prototype, "setItem"), submit = vi.spyOn(HTMLFormElement.prototype, "submit");
    mount(); complete(); expect(onDraft).not.toHaveBeenCalled();
    expect(host.querySelectorAll("a,iframe,form,img")).toHaveLength(0);
    expect(control<HTMLTextAreaElement>("答案正文（人工转录）").value).toContain("PRIVATE_SYNTHETIC_ANSWER_2");
    const outsideEditors = host.cloneNode(true) as HTMLElement;
    outsideEditors.querySelectorAll("textarea").forEach(node => node.remove());
    expect(outsideEditors.textContent).not.toContain("PRIVATE_SYNTHETIC_ANSWER_2");
    click(button()); expect(onDraft.mock.calls[0]![0].answer.content.text).toContain("PRIVATE_SYNTHETIC_ANSWER_2");
    expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    storage.mockRestore(); submit.mockRestore();
  });
  it("uses distinct accessible IDs for multiple mounted editors", () => {
    act(() => root.render(createElement("div", null, createElement(MaterialMappingDraft, { input: metadata(), onDraft }), createElement(MaterialMappingDraft, { input: metadata(), onDraft }))));
    const ids = [...host.querySelectorAll("[id]")].map(node => node.id); expect(new Set(ids).size).toBe(ids.length);
    for (const label of host.querySelectorAll("label[for]")) expect(document.getElementById(label.getAttribute("for")!)).not.toBeNull();
  });
});
