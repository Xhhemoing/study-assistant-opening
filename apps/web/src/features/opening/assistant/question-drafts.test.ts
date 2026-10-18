import { describe, expect, it } from "vitest";
import { createQuestionDraftStore } from "./question-drafts";
function memory() {
  const values = new Map<string, string>();
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
