// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CourseAddMaterials } from "./course-add-materials";
const courseId = "11111111-1111-4111-8111-111111111111", sourceId = "22222222-2222-4222-8222-222222222222";
const source = { id: sourceId, name: "材料.pdf", workspaceId: courseId, mime: "application/pdf", bytes: 123, sha256: "ab".repeat(32), version: 0, uploadState: "uploaded", parseState: "ready", error: null, createdAt: "2026-11-08T12:00:00.000Z" };
const membership = { id: "33333333-3333-4333-8333-333333333333", courseId, assetType: "source", assetId: sourceId, purpose: null, updatedAt: "2026-11-08T12:00:00.123Z" };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent?.includes(label))!;
async function mount(onAdded = vi.fn(), id = courseId) { await act(async () => root.render(<CourseAddMaterials courseId={id} assets={[]} onAdded={onAdded} />)); return onAdded; }
async function selectMaterial() { await act(async () => button("添加材料").click()); await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click()); }
function transport(post: (init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST" ? post(init) : Response.json([source]));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}

it("keeps role separate, defaults to explicit null, and close cancels without any write", async () => {
  const fetcher = transport(() => Response.json({ membership })); await mount(); await selectMaterial();
  expect((host.querySelector('[aria-label="本课程用途"]') as HTMLSelectElement).value).toBe("");
  expect((host.querySelector('[aria-label="材料角色"]') as HTMLSelectElement).value).toBe("reference");
  expect(host.textContent).toContain("未分类表示尚未指定用途");
  await act(async () => (host.querySelector('[aria-label="关闭添加材料"]') as HTMLButtonElement).click());
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("confirms selected purpose once even on double click; only verified acknowledgement triggers reload", async () => {
  let resolve!: (response: Response) => void;
  const fetcher = transport(() => new Promise(done => { resolve = done; })); const onAdded = await mount(); await selectMaterial();
  await act(async () => { const node = host.querySelector('[aria-label="本课程用途"]') as HTMLSelectElement; node.value = "mock_exam"; node.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(onAdded).not.toHaveBeenCalled();
  await act(async () => { const save = button("确认挂接"); save.click(); save.click(); });
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST"); expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0]![1]!.body))).toMatchObject({ purpose: "mock_exam", role: "reference", visibility: "private" });
  expect(onAdded).not.toHaveBeenCalled();
  expect((host.querySelector('[aria-label="关闭添加材料"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => resolve(Response.json({ membership: { ...membership, purpose: "mock_exam" } }, { status: 201 })));
  expect(onAdded).toHaveBeenCalledTimes(1); expect(host.querySelector('[aria-label="本课程用途"]')).toBeNull();
});

it.each([403, 409, 500])("does not turn status %s into successful classification or auto retry", async status => {
  const fetcher = transport(() => Response.json({ error: { code: status === 409 ? "CONFLICT" : "FORBIDDEN", message: "SECRET" } }, { status }));
  const onAdded = await mount(); await selectMaterial(); await act(async () => button("确认挂接").click());
  expect(onAdded).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("SECRET");
  expect(host.textContent).toContain("1 份未完成"); expect(button("确认挂接").disabled).toBe(true);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("partial batch stops on denial and preserves per-item failure without claiming unsubmitted rows succeeded", async () => {
  let writes = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST") return Response.json([source, { ...source, id: "44444444-4444-4444-8444-444444444444", name: "第二份" }, { ...source, id: "55555555-5555-4555-8555-555555555555", name: "第三份" }]);
    return ++writes === 1 ? Response.json({ membership }) : Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  });
  vi.stubGlobal("fetch", fetcher); const onAdded = await mount(); await act(async () => button("添加材料").click());
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(node => node.click()));
  await act(async () => button("确认挂接").click());
  expect(writes).toBe(2); expect(onAdded).not.toHaveBeenCalled();
  expect(host.textContent).toContain("1 份挂接成功，2 份未完成"); expect(host.textContent).toContain("尚未提交");
  await act(async () => button("刷新课程材料后核对").click());
  expect(onAdded).toHaveBeenCalledTimes(1);
});

it("course change discards pending selection and ignores old course completion", async () => {
  let resolve!: (response: Response) => void; transport(() => new Promise(done => { resolve = done; }));
  const onAdded = await mount(); await selectMaterial(); await act(async () => button("确认挂接").click());
  await mount(onAdded, "44444444-4444-4444-8444-444444444444");
  await act(async () => resolve(Response.json({ membership })));
  expect(onAdded).not.toHaveBeenCalled(); expect(host.querySelector('input[type="checkbox"]')).toBeNull();
});
