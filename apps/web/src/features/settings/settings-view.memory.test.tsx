// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssistantCandidateRecord, MemoryItem } from "@aistudy/contracts";

const api = vi.hoisted(() => ({
  listCandidates: vi.fn(), listMemory: vi.fn(), decideMemoryCandidate: vi.fn(), decideMemory: vi.fn(),
}));
vi.mock("../opening/client/api", () => ({ createOpeningApi: () => ({ ...api }) }));
vi.mock("../opening/timetable/semester-settings-form", () => ({ SemesterSettingsForm: () => null }));
vi.mock("../opening/timetable/timetable-import", () => ({ TimetableImport: () => null }));
vi.mock("../opening/teaching/preference-controls", () => ({ PreferenceControls: () => null }));
vi.mock("./quick-setup-panel", () => ({ QuickSetupPanel: () => null }));
vi.mock("../opening/settings/appearance-settings", () => ({ AppearanceSettings: () => null }));
vi.mock("../opening/v3/motion/view-transition", () => ({ TransitionLink: "a" }));
import { SettingsView } from "./settings-view";

const id = "11111111-1111-4111-8111-111111111111";
const at = "2026-10-25T15:00:00.000Z";
const memory: MemoryItem = { id, workspaceId: id, courseId: null, kind: "confirmed", text: "希望先看例子", sourceTurnIds: [id], version: 1, expiresAt: null, status: "active", createdAt: at, updatedAt: at };
const candidate: AssistantCandidateRecord = { id, workspaceId: id, version: 0, candidate: { kind: "memory", text: "偏好具体例子", temporary: false }, sourceTurnId: id, sourceIds: [], status: "pending", createdAt: at };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  api.listCandidates.mockResolvedValue([]); api.listMemory.mockResolvedValue({ items: [], context: [], review: [] });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ learningPreferences: {} }) })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find(row => row.textContent === label);

it("opens memory management from settings and preserves candidate confirmation and deletion consent", async () => {
  api.listCandidates.mockResolvedValue([candidate]);
  api.listMemory.mockResolvedValue({ items: [memory], context: [], review: [] });
  await act(async () => root.render(<SettingsView basePath="/opening/settings" />));
  expect(host.querySelector('nav a[href="#memory"]')?.textContent).toBe("记忆管理");
  const section = host.querySelector("#memory");
  expect(section?.textContent).toContain(memory.text);
  expect(section?.textContent).toContain(candidate.candidate.kind === "memory" ? candidate.candidate.text : "");
  expect(api.decideMemoryCandidate).not.toHaveBeenCalled();
  await act(async () => button("确认")!.click());
  expect(api.decideMemoryCandidate).toHaveBeenCalledWith({ id, expectedVersion: 0, action: "confirm", expiresAt: null, clientKey: `memory-ui-${id}-confirm` });
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
  await act(async () => button("删除记忆")!.click());
  expect(api.decideMemory).not.toHaveBeenCalled();
  confirm.mockReturnValueOnce(true).mockReturnValueOnce(false);
  await act(async () => button("删除记忆")!.click());
  expect(api.decideMemory).toHaveBeenCalledWith({ id, expectedVersion: 1, action: "delete", deleteSourceText: false, clientKey: `memory-delete-${id}-1-memory` });
  expect(host.querySelector('a[href="/opening/suggestions"]')).not.toBeNull();
});

it("keeps memory state and the API identity stable across settings renders, and offers retry on read failure", async () => {
  api.listMemory.mockRejectedValueOnce(new Error("读取失败"));
  await act(async () => root.render(<SettingsView />));
  expect(host.querySelector("#memory")?.textContent).toContain("读取失败");
  api.listMemory.mockResolvedValue({ items: [memory], context: [], review: [] });
  await act(async () => button("重新读取记忆")!.click());
  expect(host.querySelector("#memory")?.textContent).toContain(memory.text);
  expect(api.listMemory).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<SettingsView basePath="/opening/settings" />));
  expect(api.listMemory).toHaveBeenCalledTimes(2);
  expect(host.querySelector("#memory")?.textContent).toContain(memory.text);
});
