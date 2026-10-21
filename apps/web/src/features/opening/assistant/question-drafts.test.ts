import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuestionDraftStore } from "./question-drafts";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
const cleanups: Array<() => void> = [];
function identify(id: string, workspaceId = "workspace-1") {
  cleanups.push(publishVerifiedSessionIdentity({ id, workspaceId }));
}
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  identify("account-A");
});
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
function memory(values = new Map<string, string>()) {
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe("unsent question drafts", () => {
  it("restores exact text for the same context while keeping other courses and units isolated", () => {
    const storage = memory(), first = createQuestionDraftStore(storage);
    first.write("course-a:unit-a:v1", "未发送问题\n保留换行");
    const reopened = createQuestionDraftStore(storage);
    expect(reopened.read("course-a:unit-a:v1")).toBe("未发送问题\n保留换行");
    expect(reopened.read("course-b:unit-a:v1")).toBeNull();
    expect(reopened.read("course-a:unit-a:v2")).toBeNull();
  });
  it("clears sent, discarded or ephemeral drafts without resurrecting older text", () => {
    const store = createQuestionDraftStore(memory());
    store.write("unit", "旧问题"); store.write("unit", "");
    expect(store.read("unit")).toBeNull();
    store.write("unit", "新问题"); store.remove("unit");
    expect(store.read("unit")).toBeNull();
    store.write("unit", "旧问题"); store.write("unit", "x".repeat(20001));
    expect(store.read("unit")).toBeNull();
  });
  it.each(["bad json", JSON.stringify({ version: 2, text: "旧格式" }), JSON.stringify({ version: 1, text: 123 }), JSON.stringify({ version: 1, text: "x".repeat(20001) })])("ignores corrupt or unbounded saved data", raw => {
    const store = createQuestionDraftStore({ getItem: () => raw, setItem: () => {}, removeItem: () => {} });
    expect(store.read("unit")).toBeNull();
  });
  it("keeps typing and sending available when session storage is blocked", () => {
    const fail = () => { throw new Error("denied"); };
    const store = createQuestionDraftStore({ getItem: fail, setItem: fail, removeItem: fail });
    expect(store.read("unit")).toBeNull();
    expect(() => store.write("unit", "问题")).not.toThrow();
    expect(() => store.remove("unit")).not.toThrow();
  });
  it("keeps the newest question across remounts after quota failures without reading stale disk", () => {
    const disk = new Map<string, string>();
    const storage = { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => { disk.set(key, value); }, removeItem: (key: string) => { disk.delete(key); } };
    const initial = createQuestionDraftStore(storage);
    initial.write("unit-a", "旧问题");
    storage.setItem = () => { throw new Error("quota"); };
    initial.write("unit-a", "最新但尚未发送的问题");
    const remounted = createQuestionDraftStore(storage);
    expect(remounted.read("unit-a")).toBe("最新但尚未发送的问题");
    expect(remounted.read("unit-b")).toBeNull();
    expect(remounted.unavailable).toBe(true);
  });
  it("shares only a given storage's document memory and preserves a cleared or ephemeral tombstone", () => {
    const firstStorage = memory();
    const first = createQuestionDraftStore(firstStorage);
    first.write("unit", "不应恢复的旧草稿");
    firstStorage.removeItem = () => { throw new Error("denied"); };
    first.remove("unit");
    expect(createQuestionDraftStore(firstStorage).read("unit")).toBeNull();
    expect(createQuestionDraftStore(firstStorage).unavailable).toBe(true);
    const other = createQuestionDraftStore(memory());
    other.write("unit", "另一个存储的草稿");
    expect(other.read("unit")).toBe("另一个存储的草稿");
    expect(createQuestionDraftStore(firstStorage).read("unit")).toBeNull();
  });
  it("retains current-document text when storage reads and writes are denied, and clears it for ephemeral mode", () => {
    const fail = () => { throw new Error("denied"); };
    const storage = { getItem: fail, setItem: fail, removeItem: fail };
    const first = createQuestionDraftStore(storage);
    expect(first.read("unit")).toBeNull();
    first.write("unit", "临时保留的问题");
    expect(createQuestionDraftStore(storage).read("unit")).toBe("临时保留的问题");
    first.remove("unit");
    expect(createQuestionDraftStore(storage).read("unit")).toBeNull();
  });

});


describe("question draft ownership", () => {
  it("isolates accounts and workspaces in both memory and persisted drafts, including late A callbacks", () => {
    const disk = new Map<string, string>();
    const storage = memory(disk);
    const accountA = createQuestionDraftStore(storage);
    accountA.write("free-question", "A 私密草稿");
    identify("account-B");
    const accountB = createQuestionDraftStore(storage);
    expect(accountB.read("free-question")).toBeNull();
    accountB.write("free-question", "B 自己的草稿");
    accountA.write("free-question", "A 的迟到保存");
    expect(accountB.read("free-question")).toBe("B 自己的草稿");
    // A new storage facade simulates a refreshed document without the old memory cache.
    expect(createQuestionDraftStore(memory(disk)).read("free-question")).toBe("B 自己的草稿");
    identify("account-A", "workspace-2");
    expect(createQuestionDraftStore(storage).read("free-question")).toBeNull();
    identify("account-A");
    expect(createQuestionDraftStore(storage).read("free-question")).toBe("A 的迟到保存");
    expect(createQuestionDraftStore(memory(disk)).read("free-question")).toBe("A 的迟到保存");
    accountA.remove("free-question");
    identify("account-B");
    expect(createQuestionDraftStore(memory(disk)).read("free-question")).toBe("B 自己的草稿");
  });

  it("does not claim or delete legacy drafts whose account was never recorded", () => {
    const legacyKey = "opening:question-draft:free-question";
    const legacyText = JSON.stringify({ version: 1, text: "来源账户未知的私密草稿" });
    const disk = new Map([[legacyKey, legacyText]]);
    identify("account-B");
    const store = createQuestionDraftStore(memory(disk));
    expect(store.read("free-question")).toBeNull();
    store.write("free-question", "B 草稿");
    store.remove("free-question");
    expect(disk.get(legacyKey)).toBe(legacyText);
  });

  it("partitions storage-unavailable memory by the captured verified identity", () => {
    const accountA = createQuestionDraftStore();
    accountA.write("free-question", "A 页面内草稿");
    identify("account-B");
    const accountB = createQuestionDraftStore();
    expect(accountB.read("free-question")).toBeNull();
    accountB.write("free-question", "B 页面内草稿");
    accountA.write("free-question", "A 迟到草稿");
    expect(accountB.read("free-question")).toBe("B 页面内草稿");
    identify("account-A");
    expect(createQuestionDraftStore().read("free-question")).toBe("A 迟到草稿");
  });

  it("keeps drafts created without verified identity local to that store and never persists or adopts them", () => {
    cleanups.splice(0).forEach(cleanup => cleanup());
    const disk = new Map<string, string>();
    const storage = memory(disk);
    const anonymous = createQuestionDraftStore(storage);
    anonymous.write("free-question", "未验证身份草稿");
    expect(anonymous.read("free-question")).toBe("未验证身份草稿");
    expect(createQuestionDraftStore(storage).read("free-question")).toBeNull();
    identify("account-B");
    expect(createQuestionDraftStore(storage).read("free-question")).toBeNull();
    anonymous.write("free-question", "未验证身份迟到保存");
    expect(disk.size).toBe(0);
    expect(anonymous.unavailable).toBe(true);
  });

  it("does not share server-side drafts between requests", () => {
    vi.stubGlobal("window", undefined);
    const first = createQuestionDraftStore();
    first.write("free-question", "另一请求的草稿");
    expect(createQuestionDraftStore().read("free-question")).toBeNull();
  });
});
