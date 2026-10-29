import { afterEach, describe, expect, it, vi } from "vitest";
import { SENSEWEAVE_INITIAL_GATES } from "@aistudy/config/public";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { prepareSenseWeave, senseWeaveAdapter, senseWeaveFeedback } from "./senseweave-host";
import { observeSenseWeave, recordSenseWeaveRevert, senseWeaveShadowSchema, senseWeaveShadowSnapshot, shadowRecord } from "./senseweave-telemetry";

const text = `Private explanation ${"keep-private ".repeat(12)}\n\n| Secret label | Count (题) |\n|---|---|\n| Alice | 1 |\n| Bob | 2 |\n| Carol | 3 |\n| Dan | 4 |\n| Eve | 5 |`;
afterEach(() => { vi.unstubAllGlobals(); });
function browser() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  return values;
}

describe("SenseWeave beta privacy and isolation", () => {
  it("projects only strict aggregate metadata, never source, ids, offsets, free-form reasons or prompt", () => {
    const result = prepareSenseWeave({ id: "private_message", text }, "Private prompt");
    const record = shadowRecord(result, text.length, SENSEWEAVE_INITIAL_GATES.version);
    expect(senseWeaveShadowSchema.safeParse(record).success).toBe(true);
    expect(record.selected).toEqual([{ type: "table", score: 0.7 }]);
    const serialized = JSON.stringify(record);
    for (const secret of ["Alice", "Bob", "Secret label", "Private prompt", "private_message", "start", "end", "source"]) expect(serialized).not.toContain(secret);
    expect(senseWeaveShadowSchema.safeParse({ ...record, userId: "secret" }).success).toBe(false);
  });
  it("counts one answer and explicit revert once, with a bounded local buffer and no remote sender", () => {
    browser(); publishVerifiedSessionIdentity({ id: "A", workspaceId: "W" });
    const prepared = prepareSenseWeave({ id: "one", text }, undefined);
    const replacement = { ...prepared };
    observeSenseWeave(prepared, text.length, SENSEWEAVE_INITIAL_GATES.version, false, "stable-id");
    observeSenseWeave(replacement, text.length, SENSEWEAVE_INITIAL_GATES.version, false, "stable-id");
    expect(senseWeaveShadowSnapshot().records).toHaveLength(1);
    observeSenseWeave(prepared, text.length, SENSEWEAVE_INITIAL_GATES.version, false);
    observeSenseWeave(prepared, text.length, SENSEWEAVE_INITIAL_GATES.version, true);
    observeSenseWeave(prepared, text.length, SENSEWEAVE_INITIAL_GATES.version, true);
    recordSenseWeaveRevert(prepared, "block"); recordSenseWeaveRevert(prepared, "block");
    expect(senseWeaveShadowSnapshot().records).toHaveLength(1);
    expect(senseWeaveShadowSnapshot().metrics).toEqual({ shownBlocks: 1, revertedBlocks: 1, revertRate: 1 });
    observeSenseWeave(prepared, text.length, SENSEWEAVE_INITIAL_GATES.version, true, "stable-id");
    observeSenseWeave(replacement, text.length, SENSEWEAVE_INITIAL_GATES.version, true, "stable-id");
    recordSenseWeaveRevert(replacement, "block");
    expect(senseWeaveShadowSnapshot().metrics.revertedBlocks).toBe(1);
    for (let i = 0; i < 510; i++) observeSenseWeave({ ...prepared }, text.length, SENSEWEAVE_INITIAL_GATES.version, false);
    expect(senseWeaveShadowSnapshot().records).toHaveLength(500);
    publishVerifiedSessionIdentity({ id: "B", workspaceId: "W" });
    expect(senseWeaveShadowSnapshot().records).toHaveLength(0);
  });
  it("persists explicit feedback per verified account/workspace and never adopts legacy unowned storage", () => {
    const values = browser();
    values.set("aistudy.senseweave.preferences.v1", JSON.stringify({ "explain:table": { positive: 0, negative: 50 } }));
    publishVerifiedSessionIdentity({ id: "A", workspaceId: "W" });
    const a = prepareSenseWeave({ id: "one", text }, undefined);
    expect(senseWeaveAdapter().preferences.snapshot()).toEqual({});
    senseWeaveFeedback(a, "table", false);
    expect(senseWeaveAdapter().preferences.snapshot()).toEqual({ "explain:table": { positive: 0, negative: 1 } });
    publishVerifiedSessionIdentity({ id: "B", workspaceId: "W" });
    expect(senseWeaveAdapter().preferences.snapshot()).toEqual({});
    senseWeaveFeedback(a, "table", false); // late A callback cannot write B's key
    expect(senseWeaveAdapter().preferences.snapshot()).toEqual({});
    publishVerifiedSessionIdentity({ id: "A", workspaceId: "W" });
    expect(senseWeaveAdapter().preferences.snapshot()).toEqual({ "explain:table": { positive: 0, negative: 2 } });
    publishVerifiedSessionIdentity({ id: "A", workspaceId: "Other" });
    expect(senseWeaveAdapter().preferences.snapshot()).toEqual({});
  });
  it("gates only remove allowed components and a mode-based hint wins over misleading question text", () => {
    const gates = structuredClone(SENSEWEAVE_INITIAL_GATES);
    gates.presets.explain = ["prose"];
    expect(prepareSenseWeave({ id: "gated", text }, undefined, gates).enhanced).toBe(false);
    expect(prepareSenseWeave({ id: "hint", text, mode: "hint" }, "比较成绩数据").enhanced).toBe(false);
    expect(prepareSenseWeave({ id: "legacy-study", text }, undefined, SENSEWEAVE_INITIAL_GATES, true).preset).toBe("hint");
    expect(prepareSenseWeave({ id: "explained", text, mode: "explain" }, undefined, SENSEWEAVE_INITIAL_GATES, true).enhanced).toBe(true);
  });
  it("derivation is a known shadow type, not folded into other", () => {
    const answer = `请先通读题目，标出已知量、未知量和隐含条件，再决定使用哪个公式。这一题的思路是先把已知条件整理清楚，再逐步代入，每一步都检查单位和符号，避免把中间量弄混。下面是完整的推导过程，请逐行核对。先写出 a=1。再代入得到 b=a+1=2。最后得到 c=b+1=3。`;
    const record = shadowRecord(prepareSenseWeave({ id: "derivation", text: answer, mode: "explain" }, undefined), answer.length, SENSEWEAVE_INITIAL_GATES.version);
    expect(record.selected.map(row => row.type)).toEqual(["derivation"]);
    expect(record.gateVersion).toBe("sw-gates-v1-20261029");
    expect(senseWeaveShadowSchema.safeParse(record).success).toBe(true);
  });
  it("storage exceptions degrade to per-tab feedback without throwing or leaking", () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("denied"); } });
    publishVerifiedSessionIdentity({ id: "storage-denied", workspaceId: "W" });
    const prepared = prepareSenseWeave({ id: "one", text }, undefined);
    expect(() => senseWeaveFeedback(prepared, "table", false)).not.toThrow();
    expect(senseWeaveAdapter().preferences.snapshot()).toEqual({ "explain:table": { positive: 0, negative: 1 } });
  });
});
