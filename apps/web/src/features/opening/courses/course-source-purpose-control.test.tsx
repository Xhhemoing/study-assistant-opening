// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CourseSourcePurposeControl } from "./course-source-purpose-control";
import { CourseSourcePurposeError, type CourseSourceMembership, type CourseSourcePurposeClient } from "./course-source-purpose-client";

const courseId = "11111111-1111-4111-8111-111111111111", sourceId = "22222222-2222-4222-8222-222222222222";
const current: CourseSourceMembership = { id: "33333333-3333-4333-8333-333333333333", courseId, assetType: "source", assetId: sourceId, purpose: null, updatedAt: "2026-11-08T12:00:00.123Z" };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent === label)!;
async function choose(value: string) { await act(async () => { const node = host.querySelector("select")!; node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); }); }
function client(): CourseSourcePurposeClient { return { read: vi.fn(async () => current), update: vi.fn(async (_id, row, purpose) => ({ ...row, purpose, updatedAt: "2026-11-08T12:00:00.124Z" })), add: vi.fn() }; }
async function mount(api: CourseSourcePurposeClient, id = courseId) { await act(async () => root.render(<CourseSourcePurposeControl courseId={id} sourceId={sourceId} sourceName="材料" client={api} />)); }

it("labels null unclassified, requires explicit confirmation, and cancellation never writes", async () => {
  const api = client(); await mount(api);
  expect(host.textContent).toContain("用途：未分类");
  await act(async () => button("修改用途").click());
  expect(button("确认修改用途").disabled).toBe(true);
  await choose("mock_exam");
  expect(host.textContent).toContain("模考材料不参与教学");
  expect(host.textContent).toContain("引用材料仅作引用，不生成练习");
  expect(host.textContent).toContain("练习材料用于练习，不自动当作教材");
  expect(host.textContent).toContain("不删除资料、成绩、历史作答或曝光记录");
  expect(api.update).not.toHaveBeenCalled();
  await act(async () => button("取消").click());
  expect(api.update).not.toHaveBeenCalled();
  await act(async () => button("修改用途").click());
  expect(host.querySelector("select")!.value).toBe("");
});

it("double-click submits exactly once and displays success only after acknowledgement", async () => {
  const api = client(); let resolve!: (row: CourseSourceMembership) => void;
  vi.mocked(api.update).mockImplementation(() => new Promise(done => { resolve = done; }));
  await mount(api); await act(async () => button("修改用途").click()); await choose("practice");
  await act(async () => { const save = button("确认修改用途"); save.click(); save.click(); });
  expect(api.update).toHaveBeenCalledExactlyOnceWith(courseId, current, "practice");
  expect(host.textContent).not.toContain("已保存");
  expect(button("取消").disabled).toBe(true);
  await act(async () => resolve({ ...current, purpose: "practice", updatedAt: "2026-11-08T12:00:00.124Z" }));
  expect(host.textContent).toContain("用途：练习材料"); expect(host.textContent).toContain("本课程用途已保存");
});

it("CAS conflict refreshes without replay; new confirmation uses the refreshed snapshot", async () => {
  const api = client(); const latest = { ...current, purpose: "reference" as const, updatedAt: "2026-11-08T12:00:00.125Z" };
  vi.mocked(api.read).mockResolvedValueOnce(current).mockResolvedValue(latest);
  vi.mocked(api.update).mockRejectedValueOnce(new CourseSourcePurposeError(409, "CONFLICT"));
  await mount(api); await act(async () => button("修改用途").click()); await choose("teaching"); await act(async () => button("确认修改用途").click());
  expect(api.update).toHaveBeenCalledTimes(1); expect(api.read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("未覆盖他人修改"); expect(host.textContent).toContain("用途：仅作引用"); expect(host.querySelector("select")).toBeNull();
  await act(async () => button("修改用途").click()); expect(host.querySelector("select")!.value).toBe("reference");
  await choose("practice"); await act(async () => button("确认修改用途").click());
  expect(vi.mocked(api.update).mock.calls[1]).toEqual([courseId, latest, "practice"]);
});

it("permission denial stays denied, discards the editable snapshot and never claims success", async () => {
  const api = client(); vi.mocked(api.update).mockRejectedValue(new CourseSourcePurposeError(403, "WORKSPACE_FORBIDDEN"));
  await mount(api); await act(async () => button("修改用途").click()); await choose("teaching"); await act(async () => button("确认修改用途").click());
  expect(host.textContent).toContain("没有权限"); expect(host.textContent).not.toContain("已保存");
  expect(host.querySelector("select")).toBeNull(); expect([...host.querySelectorAll("button")].some(node => node.textContent === "修改用途")).toBe(false);
  expect(api.update).toHaveBeenCalledTimes(1);
});

it("network failure blocks resubmission until an explicit read, never replaying the failed draft", async () => {
  const api = client(); vi.mocked(api.update).mockRejectedValue(new TypeError("lost"));
  await mount(api); await act(async () => button("修改用途").click()); await choose("practice"); await act(async () => button("确认修改用途").click());
  expect(host.textContent).toContain("尚未确认"); expect(host.querySelector("select")).toBeNull();
  await act(async () => button("刷新用途").click());
  expect(api.update).toHaveBeenCalledTimes(1); expect(api.read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("用途：未分类");
});

it("a failed conflict refresh leaves no stale editable snapshot", async () => {
  const api = client(); vi.mocked(api.read).mockResolvedValueOnce(current).mockRejectedValue(new Error("offline"));
  vi.mocked(api.update).mockRejectedValue(new CourseSourcePurposeError(409, "CONFLICT"));
  await mount(api); await act(async () => button("修改用途").click()); await choose("practice"); await act(async () => button("确认修改用途").click());
  expect(host.textContent).toContain("用途暂不可核对"); expect(host.querySelector("select")).toBeNull();
  expect(api.update).toHaveBeenCalledTimes(1);
});

it("the mounted default control reads and patches the real API URLs with the exact CAS snapshot", async () => {
  const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === "PATCH"
    ? Response.json({ membership: { ...current, purpose: "reference", updatedAt: "2026-11-08T12:00:00.124Z" } })
    : Response.json({ assets: [current] }));
  vi.stubGlobal("fetch", transport);
  await act(async () => root.render(<CourseSourcePurposeControl courseId={courseId} sourceId={sourceId} sourceName="材料" />));
  await act(async () => button("修改用途").click()); await choose("reference"); await act(async () => button("确认修改用途").click());
  expect(transport.mock.calls.map(([url]) => url)).toEqual([`/api/courses/${courseId}/assets`, `/api/courses/${courseId}/memberships`]);
  expect(JSON.parse(String(transport.mock.calls[1]![1]!.body))).toEqual({ assetType: "source", assetId: sourceId, purpose: "reference", expectedUpdatedAt: current.updatedAt });
  expect(host.textContent).toContain("本课程用途已保存");
});

it("late read from course A cannot overwrite course B or reveal an old editor", async () => {
  const api = client(); let resolve!: (row: CourseSourceMembership) => void;
  vi.mocked(api.read).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await mount(api);
  const other = "44444444-4444-4444-8444-444444444444";
  vi.mocked(api.read).mockResolvedValue({ ...current, courseId: other, purpose: "practice" });
  await mount(api, other); await act(async () => resolve({ ...current, purpose: "teaching" }));
  expect(host.textContent).toContain("用途：练习材料"); expect(host.textContent).not.toContain("用途：教学材料");
  expect(api.update).not.toHaveBeenCalled();
});

it("late acknowledgement from course A cannot populate course B for the same source", async () => {
  const api = client(); let resolve!: (row: CourseSourceMembership) => void;
  vi.mocked(api.update).mockImplementation(() => new Promise(done => { resolve = done; }));
  await mount(api); await act(async () => button("修改用途").click()); await choose("mock_exam"); await act(async () => button("确认修改用途").click());
  const other = "44444444-4444-4444-8444-444444444444";
  vi.mocked(api.read).mockResolvedValue({ ...current, courseId: other, purpose: "reference" });
  await mount(api, other); await act(async () => resolve({ ...current, purpose: "mock_exam" }));
  expect(host.textContent).toContain("用途：仅作引用"); expect(host.textContent).not.toContain("已保存");
  expect(api.update).toHaveBeenCalledTimes(1);
});
