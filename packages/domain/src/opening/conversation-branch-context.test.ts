import { describe, expect, it } from "vitest";
import {
  selectConversationBranchContext as select, type BranchContextInput, type BranchParentExchange,
  type BranchContextResult,
} from "./conversation-branch-context";

const ref = { sourceId: "SOURCE-A", sourceVersion: 2 };
function exchange(id: string, question = `question ${id}`, answer = `answer ${id}`): BranchParentExchange {
  return { exchangeId: id, conversationId: "parent", user: {
    id, text: question, status: "complete", querySystem: false, hasSystemQueryReceipt: false, sourceRefs: [ref],
  }, assistant: {
    id: `${id}-a`, text: answer, status: "complete", querySystem: false, hasSystemQueryReceipt: false, sourceRefs: [ref],
  } };
}
function input(changes: Partial<BranchContextInput> = {}): BranchContextInput {
  return { parentConversationId: "parent", parentListComplete: true, exchanges: [exchange("a"), exchange("b"), exchange("c")],
    forkExchangeId: "b", relation: "rephrase", purpose: "model", ...changes };
}
function success(result: BranchContextResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result;
}
const fragment = { turnId: "b-a", start: 0, end: 6, text: "answer" };

describe("selectConversationBranchContext", () => {
  it("uses stable input positions, not lexical IDs or same-time boundaries; excludes later appends", () => {
    const request = input({ exchanges: [exchange("z"), exchange("b"), exchange("a")] });
    const result = success(select(request));
    expect(result.exchangeIds).toEqual(["z", "b"]);
    expect(result.messages.map(message => message.turnId)).toEqual(["z", "z-a", "b", "b-a"]);
    expect(result.returnAnchor).toEqual({ conversationId: "parent", exchangeId: "b", turnId: "b-a" });
    expect(select({ ...request, exchanges: [...request.exchanges, exchange("new")] })).toEqual(result);
    expect(result.sourceRefs).toEqual([{ sourceId: "source-a", sourceVersion: 2 }]);
  });
  it.each(["deepen", "related"] as const)("%s inherits only the verified fork fragment and explicit bounded background", relation => {
    const request = input({ relation, fragment });
    expect(success(select(request)).messages).toEqual([{ role: "assistant", text: "answer", exchangeId: "b", turnId: "b-a", range: { start: 0, end: 6 } }]);
    const result = success(select({ ...request, backgroundExchangeIds: ["a"] }));
    expect(result.messages.map(message => message.text)).toEqual(["question a", "answer a", "answer"]);
    expect(result.exchangeIds).toEqual(["a", "b"]);
  });
  it.each([false, true])("rejects a missing fork with parentListComplete=%s", parentListComplete => {
    expect(select(input({ parentListComplete, forkExchangeId: "absent" }))).toEqual({ ok: false, reason: parentListComplete ? "fork_missing" : "incomplete_parent" });
  });
  it("rejects incomplete pairs and unknown lineage at or before the fork, not future pending turns", () => {
    const a = exchange("a"); const b = exchange("b");
    for (const broken of [
      { ...a, assistant: null }, { ...a, user: { ...a.user, status: "pending" } },
      { ...a, assistant: { ...a.assistant!, sourceRefs: null } }, { ...a, user: { ...a.user, text: " " } },
    ]) expect(select(input({ exchanges: [broken, b] }))).toEqual({ ok: false, reason: "incomplete_parent" });
    expect(success(select(input({ exchanges: [a, b, { ...exchange("c"), assistant: null }] }))).exchangeIds).toEqual(["a", "b"]);
  });
  it("rejects siblings, duplicate exchange/turn identities and mispaired exchange IDs", () => {
    const a = exchange("a");
    for (const exchanges of [
      [a, a, exchange("b")], [a, { ...exchange("b"), conversationId: "sibling" }],
      [a, { ...exchange("b"), exchangeId: "other" }],
      [a, { ...exchange("b"), assistant: { ...exchange("b").assistant!, id: "a-a" } }],
    ]) expect(select(input({ exchanges }))).toEqual({ ok: false, reason: "invalid_exchange" });
  });
  it.each([
    undefined, { ...fragment, text: "forged" }, { ...fragment, start: -1 }, { ...fragment, end: 500 },
    { ...fragment, start: 0.5 }, { ...fragment, end: 0 }, { ...fragment, turnId: "c-a" },
    { ...fragment, turnId: "a-a" },
  ])("rejects absent, stale or unlocatable fragment %j", invalidFragment => {
    expect(select(input({ relation: "deepen", fragment: invalidFragment }))).toEqual({ ok: false, reason: "invalid_selection" });
  });
  it.each([["c"], ["b"], ["sibling"], ["a", "a"], ["x", "y", "z"]].map(backgroundExchangeIds => ({ backgroundExchangeIds })))("rejects invalid background $backgroundExchangeIds", ({ backgroundExchangeIds }) => {
    expect(select(input({ relation: "related", fragment, backgroundExchangeIds }))).toEqual({ ok: false, reason: "invalid_selection" });
  });
  it("orders explicit background by parent order and shares the fork budget", () => {
    const request = input({ exchanges: [exchange("a"), exchange("b"), exchange("c"), exchange("d")],
      forkExchangeId: "c", relation: "deepen", fragment: { ...fragment, turnId: "c-a" },
      backgroundExchangeIds: ["b", "a"] });
    expect(success(select(request)).exchangeIds).toEqual(["a", "b", "c"]);
    const bounded = success(select({ ...request, budget: { maxCharacters: 24, maxExchanges: 2 } }));
    expect(bounded.exchangeIds).toEqual(["b", "c"]);
    expect(bounded.characters).toBe(24);
    expect(bounded.truncated).toBe(true);
  });
  it("verifies UTF-16 locators against server text without normalized substring guessing", () => {
    const b = exchange("b", "问题", "前😀后");
    const request = input({ exchanges: [b], relation: "related", fragment: { turnId: "b-a", start: 1, end: 3, text: "😀" } });
    expect(success(select(request)).messages[0]!.text).toBe("😀");
    expect(select({ ...request, fragment: { ...request.fragment!, start: 0 } })).toEqual({ ok: false, reason: "invalid_selection" });
  });
  it("does not silently ignore selection parameters on rephrase", () => {
    expect(select(input({ fragment }))).toEqual({ ok: false, reason: "invalid_selection" });
    expect(select(input({ backgroundExchangeIds: ["a"] }))).toEqual({ ok: false, reason: "invalid_selection" });
  });
  it("excludes flagged and legacy system query exchanges from model context", () => {
    for (const flags of [{ querySystem: true }, { hasSystemQueryReceipt: true }]) {
      const a = exchange("a");
      const query = { ...a, assistant: { ...a.assistant!, ...flags, text: "old state claim" } };
      expect(success(select(input({ exchanges: [query, exchange("b")] }))).exchangeIds).toEqual(["b"]);
      expect(success(select(input({ exchanges: [query, exchange("b")], relation: "deepen", fragment, backgroundExchangeIds: ["a"] }))).exchangeIds).toEqual(["b"]);
      expect(select(input({ exchanges: [query], forkExchangeId: "a" }))).toEqual({ ok: false, reason: "query_context" });
    }
  });
  it("record_referents keeps only user referents, not query or ordinary assistant claims", () => {
    const a = exchange("a", "that course", "system state claim");
    const query = { ...a, assistant: { ...a.assistant!, querySystem: true, hasSystemQueryReceipt: true } };
    const result = success(select(input({ exchanges: [query, exchange("b")], purpose: "record_referents" })));
    expect(result.messages.map(message => [message.role, message.text])).toEqual([["user", "that course"], ["user", "question b"]]);
    expect(result.sourceRefs).toEqual([{ sourceId: "source-a", sourceVersion: 2 }]);
    expect(select(input({ purpose: "record_referents", relation: "deepen", fragment }))).toEqual({ ok: false, reason: "invalid_selection" });
    expect(success(select(input({ purpose: "record_referents", relation: "related", fragment: { turnId: "b", start: 0, end: 8, text: "question" } }))).messages[0]!.role).toBe("user");
  });
  it("keeps a suffix of whole exchanges within both budgets; source refs follow only included context", () => {
    const a = exchange("a");
    const request = input({ exchanges: [{ ...a, user: { ...a.user, sourceRefs: [{ sourceId: "excluded", sourceVersion: 1 }] } }, exchange("b")], budget: { maxCharacters: 18, maxExchanges: 1 } });
    const result = success(select(request));
    expect(result.exchangeIds).toEqual(["b"]);
    expect(result.characters).toBe(18);
    expect(result.truncated).toBe(true);
    expect(result.sourceRefs).toEqual([{ sourceId: "source-a", sourceVersion: 2 }]);
    expect(select({ ...request, budget: { maxCharacters: 17, maxExchanges: 1 } })).toEqual({ ok: false, reason: "budget_exceeded" });
  });
  it("applies one hard global limit to long inherited history and referents", () => {
    const exchanges = Array.from({ length: 80 }, (_, index) => exchange(String(index), "q".repeat(400), "a".repeat(400)));
    for (const purpose of ["model", "record_referents"] as const) {
      const result = success(select(input({ exchanges, forkExchangeId: "79", purpose })));
      expect(result.characters).toBeLessThanOrEqual(12_000);
      expect(result.exchangeIds.length).toBeLessThanOrEqual(20);
      expect(result.exchangeIds.at(-1)).toBe("79");
      expect(result.truncated).toBe(true);
    }
  });
  it.each([
    { maxCharacters: 12_001, maxExchanges: 20 }, { maxCharacters: 12_000, maxExchanges: 21 },
    { maxCharacters: 0, maxExchanges: 1 }, { maxCharacters: NaN, maxExchanges: 1 },
    { maxCharacters: 100, maxExchanges: 1.5 },
  ])("rejects budget expansion or malformed limits %j", budget => {
    expect(select(input({ budget }))).toEqual({ ok: false, reason: "invalid_budget" });
  });
  it("never clips a required fragment to fit and never mutates inputs or shares output ref objects", () => {
    const request = input({ relation: "deepen", fragment });
    const before = JSON.stringify(request);
    expect(select({ ...request, budget: { maxCharacters: 5, maxExchanges: 1 } })).toEqual({ ok: false, reason: "budget_exceeded" });
    const result = success(select(request));
    result.sourceRefs[0] = { sourceId: "changed", sourceVersion: 0 };
    expect(JSON.stringify(request)).toBe(before);
    expect(success(select(request)).sourceRefs[0]!.sourceId).toBe("source-a");
  });
});
