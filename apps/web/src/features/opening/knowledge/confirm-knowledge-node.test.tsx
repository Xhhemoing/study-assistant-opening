import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeNode } from "@aistudy/contracts";
import { ConfirmKnowledgeNode } from "./confirm-knowledge-node";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
  },
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node: KnowledgeNode = { id: id(1), courseId: id(2), label: "函数", kind: "concept", evidenceChunkIds: [id(3)], status: "needs_check" };
const record = { version: 4, snapshot: { courseId: node.courseId, version: 4, nodes: [node], edges: [] }, sourceVersions: { [id(5)]: 2 } };
type Element = ReactElement<{ children?: unknown; onClick?: () => void; disabled?: boolean; "aria-busy"?: boolean }>;
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}
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
    const reload = elements(f.render()).filter(item => item.type === "button")[1]!;
    reload.props.onClick!(); expect(f.onReload).toHaveBeenCalledOnce();
  });
});
