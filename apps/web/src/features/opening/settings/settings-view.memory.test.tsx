// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryItem } from "@aistudy/contracts";

const api = vi.hoisted(() => ({ listMemory: vi.fn(), listCandidates: vi.fn(), decideMemory: vi.fn(), decideMemoryCandidate: vi.fn() }));
vi.mock("../client/api", () => ({ createOpeningApi: () => ({ ...api }) }));
vi.mock("../timetable/semester-settings-form", () => ({ SemesterSettingsForm: () => null }));
vi.mock("../timetable/timetable-import", () => ({ TimetableImport: () => null }));
vi.mock("../teaching/preference-controls", () => ({ PreferenceControls: () => null }));
vi.mock("./appearance-settings", () => ({ AppearanceSettings: () => null, DiagnosticsSettings: () => null }));
vi.mock("./advanced-settings-view", () => ({ AdvancedSettingsView: () => null }));
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: "a" }));
import { SettingsView } from "./settings-view";

const id = "11111111-1111-4111-8111-111111111111";
const at = "2026-10-25T15:00:00.000Z";
const memory: MemoryItem = { id, workspaceId: id, courseId: null, kind: "confirmed", text: "希望先看例子", sourceTurnIds: [id], version: 1, expiresAt: null, status: "active", createdAt: at, updatedAt: at };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  api.listMemory.mockResolvedValue({ items: [memory], context: [], review: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find(row => row.textContent === label);

it("manages confirmed memory in AI settings, preserving delete consent and the single inbox confirmation entry", async () => {
  await act(async () => root.render(<SettingsView basePath="/opening/settings" section="ai" />));
  expect(host.querySelector("#memory")?.textContent).toContain(memory.text);
  expect(host.querySelector("#memory")?.textContent).toContain("来源消息：1 条");
  expect(host.querySelector("#memory")?.textContent).not.toContain(id);
  expect(host.querySelector('a[href="/opening/suggestions"]')).not.toBeNull();
  expect(api.listCandidates).not.toHaveBeenCalled();
  expect(api.decideMemoryCandidate).not.toHaveBeenCalled();
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
  await act(async () => button("删除记忆")!.click());
  expect(api.decideMemory).not.toHaveBeenCalled();
  confirm.mockReturnValueOnce(true).mockReturnValueOnce(false);
  await act(async () => button("删除记忆")!.click());
  expect(api.decideMemory).toHaveBeenCalledWith({ id, expectedVersion: 1, action: "delete", deleteSourceText: false, clientKey: `memory-delete-${id}-1-memory` });
});

it("keeps its API identity across settings renders and offers retry after a failed memory read", async () => {
  api.listMemory.mockRejectedValueOnce(new Error("读取失败"));
  await act(async () => root.render(<SettingsView basePath="/opening/settings" section="ai" />));
  expect(host.querySelector("#memory")?.textContent).toContain("读取失败");
  await act(async () => button("重新读取记忆")!.click());
  expect(host.querySelector("#memory")?.textContent).toContain(memory.text);
  expect(api.listMemory).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<SettingsView basePath="/opening/settings" section="ai" planning={<p>changed</p>} />));
  expect(api.listMemory).toHaveBeenCalledTimes(2);
});
