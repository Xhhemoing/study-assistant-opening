// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CourseAddMaterials } from "./course-add-materials";
const courseId = "11111111-1111-4111-8111-111111111111", sourceId = "22222222-2222-4222-8222-222222222222", secondId = "44444444-4444-4444-8444-444444444444";
const source = { id: sourceId, name: "synthetic.pdf", workspaceId: courseId, mime: "application/pdf", bytes: 12, sha256: "a".repeat(64), version: 0, uploadState: "uploaded", parseState: "ready", error: null, createdAt: "2026-11-08T12:00:00.000Z" };
const row = { id: "33333333-3333-4333-8333-333333333333", courseId, assetType: "source", assetId: sourceId, purpose: null, updatedAt: "2026-11-08T12:00:00.123Z" };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent?.includes(label))!;
async function start(transport: typeof fetch) {
  vi.stubGlobal("fetch", transport); const onAdded = vi.fn();
  await act(async () => root.render(<CourseAddMaterials courseId={courseId} assets={[]} onAdded={onAdded} />));
  await act(async () => button("添加材料").click());
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(node => node.click()));
  return onAdded;
}
it.each(["lost-after-commit", "wrong-source", "ignored-purpose", "invalid-json"] as const)("add %s never claims success or submits remaining items, including close/reopen", async fault => {
  let commits = 0;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST") return Response.json([source, { ...source, id: secondId, name: "second.pdf" }]);
    if (fault === "lost-after-commit") { commits++; throw new TypeError("response lost"); }
    if (fault === "invalid-json") return new Response("broken", { status: 201 });
    return Response.json({ membership: { ...row, assetId: fault === "wrong-source" ? secondId : sourceId, purpose: null } }, { status: 201 });
  });
  const onAdded = await start(transport);
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('[aria-label="本课程用途"]')!; select.value = "practice"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { const save = button("确认挂接"); save.click(); save.click(); });
  expect(onAdded).not.toHaveBeenCalled(); expect(host.textContent).toContain("0 份挂接成功，2 份未完成"); expect(host.textContent).toContain("尚未提交"); expect(button("确认挂接").disabled).toBe(true);
  expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1); expect(commits).toBe(fault === "lost-after-commit" ? 1 : 0);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭添加材料"]')!.click());
  expect(onAdded).toHaveBeenCalledTimes(1); await act(async () => button("添加材料").click());
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(node => node.click()));
  expect(button("确认挂接").disabled).toBe(true); expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
it("does not admit pending upload, but can attach the uploaded row with role independent from purpose", async () => {
  const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST"
    ? Response.json({ membership: { ...row, purpose: "reference" } }, { status: 201 })
    : Response.json([source, { ...source, id: secondId, name: "pending.pdf", uploadState: "pending" }]));
  const onAdded = await start(transport);
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1); expect(host.textContent).toContain("pending.pdf"); expect(host.textContent).toContain("暂不可选");
  await act(async () => {
    const role = host.querySelector<HTMLSelectElement>('[aria-label="材料角色"]')!, purpose = host.querySelector<HTMLSelectElement>('[aria-label="本课程用途"]')!;
    role.value = "core"; role.dispatchEvent(new Event("change", { bubbles: true })); purpose.value = "reference"; purpose.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("确认挂接").click());
  const posts = transport.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(posts).toHaveLength(1); expect(JSON.parse(String(posts[0]![1]!.body))).toMatchObject({ assetId: sourceId, role: "core", purpose: "reference" }); expect(onAdded).toHaveBeenCalledTimes(1);
});
