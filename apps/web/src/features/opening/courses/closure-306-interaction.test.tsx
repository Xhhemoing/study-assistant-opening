// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CourseSourcePurposeControl } from "./course-source-purpose-control";
import { createCourseSourcePurposeClient, type CourseSourceMembership } from "./course-source-purpose-client";

const a = "11111111-1111-4111-8111-111111111111", b = "44444444-4444-4444-8444-444444444444";
const sourceId = "22222222-2222-4222-8222-222222222222";
const original: CourseSourceMembership = { id: "33333333-3333-4333-8333-333333333333", courseId: a, assetType: "source", assetId: sourceId, purpose: null, updatedAt: "2026-11-08T12:00:00.123Z" };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let mounts: { host: HTMLDivElement; root: Root }[];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mounts = []; });
afterEach(async () => { for (const { root, host } of mounts) { await act(async () => root.unmount()); host.remove(); } vi.unstubAllGlobals(); });
function tab() { const host = document.createElement("div"); document.body.append(host); const mounted = { host, root: createRoot(host) }; mounts.push(mounted); return mounted; }
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find(node => node.textContent === label)!;
async function edit(host: HTMLElement, value: string) {
  await act(async () => button(host, "修改用途").click());
  await act(async () => { const select = host.querySelector("select")!; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function mount(target: ReturnType<typeof tab>, transport: typeof fetch, courseId = a) {
  await act(async () => target.root.render(<CourseSourcePurposeControl courseId={courseId} sourceId={sourceId} sourceName="synthetic" client={createCourseSourcePurposeClient(transport)} />));
}

it("two mounted tabs share CAS: one write succeeds, stale tab refreshes while pending and never replays its draft", async () => {
  let stored = { ...original }, patches = 0, commits = 0, reads = 0;
  const pending = deferred<Response>();
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "PATCH") { if (++reads === 3) return pending.promise; return Response.json({ assets: [stored] }); }
    patches++; const body = JSON.parse(String(init.body));
    if (body.expectedUpdatedAt !== stored.updatedAt) return Response.json({ error: { code: "CONFLICT" } }, { status: 409 });
    commits++; stored = { ...stored, purpose: body.purpose, updatedAt: "2026-11-08T12:00:00.124Z" }; return Response.json({ membership: stored });
  });
  const left = tab(), right = tab(); await mount(left, transport); await mount(right, transport);
  await edit(left.host, "practice"); await edit(right.host, "mock_exam");
  await act(async () => button(left.host, "确认修改用途").click());
  await act(async () => button(right.host, "确认修改用途").click());
  expect({ patches, commits, reads }).toEqual({ patches: 2, commits: 1, reads: 3 });
  expect(left.host.textContent).toContain("本课程用途已保存");
  expect(right.host.textContent).not.toContain("已保存"); expect(right.host.textContent).toContain("未覆盖他人修改");
  expect(right.host.querySelector("select")).toBeNull(); expect(button(right.host, "修改用途")).toBeUndefined(); expect(button(right.host, "刷新用途").disabled).toBe(true);
  await act(async () => pending.resolve(Response.json({ assets: [stored] })));
  expect(right.host.textContent).toContain("用途：练习材料"); expect(right.host.textContent).not.toContain("已保存"); expect(patches).toBe(2);
  await edit(right.host, "reference"); expect(right.host.querySelector("select")!.value).toBe("reference");
  await act(async () => button(right.host, "取消").click()); expect(patches).toBe(2);
});

it("failed conflict refresh requires an explicit read and restores no stale editor or success", async () => {
  let reads = 0;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "PATCH") return Response.json({ error: { code: "CONFLICT" } }, { status: 409 });
    if (++reads === 2) throw new TypeError("offline");
    return Response.json({ assets: [reads === 1 ? original : { ...original, purpose: "reference", updatedAt: "2026-11-08T12:00:00.124Z" }] });
  });
  const view = tab(); await mount(view, transport); await edit(view.host, "teaching");
  await act(async () => button(view.host, "确认修改用途").click());
  expect(view.host.textContent).toContain("用途暂不可核对"); expect(view.host.textContent).not.toContain("已保存"); expect(button(view.host, "修改用途")).toBeUndefined();
  await act(async () => button(view.host, "刷新用途").click());
  expect(view.host.textContent).toContain("用途：仅作引用"); await edit(view.host, "reference"); expect(button(view.host, "确认修改用途").disabled).toBe(true);
  expect(transport.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
});

it("lost response after a synthetic commit is uncertain, explicit refresh and remount show persisted purpose without replay", async () => {
  let stored = { ...original };
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "PATCH") { stored = { ...stored, purpose: "practice", updatedAt: "2026-11-08T12:00:00.124Z" }; throw new TypeError("lost response"); }
    return Response.json({ assets: [stored] });
  });
  const first = tab(); await mount(first, transport); await edit(first.host, "practice");
  await act(async () => button(first.host, "确认修改用途").click());
  expect(first.host.textContent).toContain("尚未确认"); expect(first.host.textContent).not.toContain("已保存"); expect(button(first.host, "修改用途")).toBeUndefined();
  await act(async () => button(first.host, "刷新用途").click());
  expect(first.host.textContent).toContain("用途：练习材料"); expect(first.host.textContent).not.toContain("已保存");
  await act(async () => first.root.render(null)); const reopened = tab(); await mount(reopened, transport);
  expect(reopened.host.textContent).toContain("用途：练习材料"); expect(reopened.host.textContent).not.toContain("已保存");
  expect(transport.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
});

it.each(["reject", "conflict"] as const)("late %s from course A cannot replace course B state or cause conflict refresh in B", async outcome => {
  const pending = deferred<Response>();
  const transport = vi.fn<typeof fetch>(async (url, init) => init?.method === "PATCH" ? pending.promise
    : Response.json({ assets: [{ ...original, courseId: String(url).includes(b) ? b : a, purpose: String(url).includes(b) ? "reference" : null }] }));
  const view = tab(); await mount(view, transport); await edit(view.host, "mock_exam"); await act(async () => button(view.host, "确认修改用途").click());
  await mount(view, transport, b);
  await act(async () => outcome === "reject" ? pending.reject(new TypeError("lost A")) : pending.resolve(Response.json({ error: { code: "CONFLICT" } }, { status: 409 })));
  expect(view.host.textContent).toContain("用途：仅作引用"); expect(view.host.textContent).not.toContain("未覆盖"); expect(view.host.textContent).not.toContain("尚未确认"); expect(view.host.textContent).not.toContain("已保存");
  expect(transport).toHaveBeenCalledTimes(3);
});

it.each(["wrong-course", "stale-revision", "ignored-purpose", "invalid-json"] as const)("mounted client rejects %s acknowledgement and blocks a false success", async fault => {
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "PATCH") return Response.json({ assets: [original] });
    if (fault === "invalid-json") return new Response("not-json", { status: 200 });
    return Response.json({ membership: { ...original, purpose: fault === "ignored-purpose" ? null : "practice", courseId: fault === "wrong-course" ? b : a, updatedAt: fault === "stale-revision" ? original.updatedAt : "2026-11-08T12:00:00.124Z" } });
  });
  const view = tab(); await mount(view, transport); await edit(view.host, "practice"); await act(async () => button(view.host, "确认修改用途").click());
  expect(view.host.textContent).toContain("尚未确认"); expect(view.host.textContent).not.toContain("已保存"); expect(button(view.host, "修改用途")).toBeUndefined(); expect(view.host.querySelector("select")).toBeNull();
  expect(transport.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
});
