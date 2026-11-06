import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeNode } from "@aistudy/contracts";
import { ConfirmKnowledgeNode } from "./confirm-knowledge-node";
import { confirmedKnowledgeState } from "./course-knowledge";
import { KnowledgeEvidence } from "./knowledge-evidence";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node: KnowledgeNode = { id: id(1), courseId: id(2), label: "函数", kind: "concept", evidenceChunkIds: [id(3)], status: "needs_check" };
// snapshot.version deliberately differs from record.version: the request must pin record.version.
const record = { version: 4, snapshot: { courseId: node.courseId, version: 3, nodes: [node], edges: [] }, sourceVersions: { [id(5)]: 2 } };
type Element = ReactElement<{ children?: unknown; onClick?: () => void; disabled?: boolean; "aria-busy"?: boolean }>;
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}
function text(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (!tree || typeof tree !== "object" || !("props" in tree)) return "";
  return text((tree as Element).props.children);
}
const button = (tree: unknown, label: string) => elements(tree).find(item => item.type === "button" && text(item).includes(label))!;
function setup(current = node) {
  const onConfirmed = vi.fn(), onReload = vi.fn();
  const next = { ...record, version: 5, snapshot: { ...record.snapshot, version: 5, nodes: [{ ...node, status: "supported" as const }] } };
  const api = { confirmKnowledgeNode: vi.fn(async () => next) };
  const render = (value = current) => {
    hooks.cursor = 0;
    return ConfirmKnowledgeNode({ node: value, record, api, onConfirmed, onReload });
  };
  return { render, api, onConfirmed, onReload, next };
}
beforeEach(() => { hooks.slots = []; hooks.cursor = 0; });

describe("knowledge node manual confirmation UI", () => {
  it.each(["supported", "suggested"] as const)("does not show an action for %s", status => {
    expect(setup({ ...node, status }).render()).toBeNull();
  });
  it("shows an accessible needs_check action with its limited meaning", () => {
    const html = renderToStaticMarkup(createElement(ConfirmKnowledgeNode, { node, record,
      api: { confirmKnowledgeNode: vi.fn() }, onConfirmed: vi.fn(), onReload: vi.fn() }));
    expect(html).toContain("我已核对，确认材料依据");
    expect(html).toContain("不代表已掌握");
    expect(html).toContain("材料变化后需要重新核对");
    expect(html).toContain(`aria-describedby="confirm-meaning-${node.id}"`);
  });
  it("disables the action when no evidence is saved", () => {
    const f = setup({ ...node, evidenceChunkIds: [] });
    expect(elements(f.render()).find(item => item.type === "button")!.props.disabled).toBe(true);
  });
  it("submits observed graph/source versions, then displays the server-confirmed status", async () => {
    const f = setup();
    elements(f.render()).find(item => item.type === "button")!.props.onClick!();
    const pending = elements(f.render()).find(item => item.type === "button")!;
    expect(pending.props.disabled).toBe(true); expect(pending.props["aria-busy"]).toBe(true);
    await vi.waitFor(() => expect(f.onConfirmed).toHaveBeenCalledWith(f.next));
    expect(f.api.confirmKnowledgeNode).toHaveBeenCalledWith(node.courseId, {
      nodeId: node.id, expectedVersion: 4, sourceVersions: record.sourceVersions,
    });
    expect(renderToStaticMarkup(f.render(f.next.snapshot.nodes[0]!))).toContain("已确认材料依据，不代表已掌握");
    expect(elements(f.render(f.next.snapshot.nodes[0]!)).some(item => item.type === "button")).toBe(false);
  });
  it("keeps needs_check on conflict and offers an explicit reload without a retry", async () => {
    const f = setup();
    f.api.confirmKnowledgeNode.mockRejectedValueOnce(new Error("材料已变化，请重新读取并核对材料。"));
    elements(f.render()).find(item => item.type === "button")!.props.onClick!();
    await vi.waitFor(() => expect(renderToStaticMarkup(f.render())).toContain("材料已变化"));
    expect(f.onConfirmed).not.toHaveBeenCalled(); expect(f.api.confirmKnowledgeNode).toHaveBeenCalledTimes(1);
    button(f.render(), "重新读取课程知识").props.onClick!(); expect(f.onReload).toHaveBeenCalledOnce();
  });
  it("sends only one request when the button is clicked twice within the same render", async () => {
    const f = setup();
    const click = button(f.render(), "我已核对").props.onClick!;
    click(); click();
    await vi.waitFor(() => expect(f.onConfirmed).toHaveBeenCalledOnce());
    expect(f.api.confirmKnowledgeNode).toHaveBeenCalledTimes(1);
  });
  it("clears the error after a failed attempt is followed by a successful one", async () => {
    const f = setup();
    f.api.confirmKnowledgeNode.mockRejectedValueOnce(new Error("材料已变化，请重新读取并核对材料。"));
    button(f.render(), "我已核对").props.onClick!();
    await vi.waitFor(() => expect(renderToStaticMarkup(f.render())).toContain("材料已变化"));
    button(f.render(), "我已核对").props.onClick!();
    await vi.waitFor(() => expect(f.onConfirmed).toHaveBeenCalledWith(f.next));
    expect(f.api.confirmKnowledgeNode).toHaveBeenCalledTimes(2);
    const html = renderToStaticMarkup(f.render());
    expect(html).not.toContain("材料已变化"); expect(html).not.toContain("role=\"alert\"");
  });
});

describe("course knowledge state after a confirmation", () => {
  const sibling: KnowledgeNode = { ...node, id: id(6), label: "映射" };
  const before = { ...record, snapshot: { ...record.snapshot, nodes: [node, sibling] } };
  const next = { ...before, version: 5, snapshot: { ...before.snapshot, version: 5,
    nodes: [{ ...node, status: "supported" as const }, sibling] } };
  it("re-maps an open evidence panel to the confirmed node so it shows the new status", () => {
    const state = confirmedKnowledgeState(next);
    expect(renderToStaticMarkup(createElement(KnowledgeEvidence, { node }))).not.toContain("已有材料依据");
    const selected = state.selected(node);
    expect(selected).toEqual(next.snapshot.nodes[0]);
    expect(renderToStaticMarkup(createElement(KnowledgeEvidence, { node: selected! }))).toContain("已有材料依据");
    expect(state.selected(null)).toBeNull();
    expect(state.selected({ ...node, id: id(99) })).toBeNull();
    expect(state.record).toBe(next); expect(state.snapshot).toBe(next.snapshot);
  });
  it("makes the next sibling confirmation pin the new graph version", async () => {
    const state = confirmedKnowledgeState(next);
    const api = { confirmKnowledgeNode: vi.fn(async () => next) };
    hooks.slots = []; hooks.cursor = 0;
    const tree = ConfirmKnowledgeNode({ node: state.snapshot.nodes[1]!, record: state.record, api, onConfirmed: vi.fn(), onReload: vi.fn() });
    button(tree, "我已核对").props.onClick!();
    await vi.waitFor(() => expect(api.confirmKnowledgeNode).toHaveBeenCalledWith(node.courseId, {
      nodeId: sibling.id, expectedVersion: 5, sourceVersions: record.sourceVersions,
    }));
  });
});
