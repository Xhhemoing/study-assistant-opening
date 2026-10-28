// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAssetLinkClient } from "./learning-asset-link-client";
import { StudyNoteComposer } from "./study-note-composer";
vi.mock("../../auth/session-identity", () => ({ getVerifiedSessionNamespace: () => "verified-note-owner" }));
vi.mock("./learning-link-target-form", () => ({ LearningLinkTargetForm: () => <p>可选关联课程、目标与要求</p> }));
vi.mock("./asset-learning-links", () => ({ AssetLearningLinks: () => <p>原活动与出处</p> }));
const id = "11111111-1111-4111-8111-111111111111";
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function client() { return { note: vi.fn(async () => ({ documentId: id, link: {} })) } as unknown as LearningAssetLinkClient; }
async function render(api: LearningAssetLinkClient, context: import("../assistant/study-conversation-context").StudyConversationContext = { label: "自由探索", fragment: "我的理解" }) { await act(async () => root.render(<StudyNoteComposer context={context} client={api} />)); }
function button(text: string) { const value = [...host.querySelectorAll("button")].find(node => node.textContent === text); if (!value) throw new Error(`missing ${text}`); return value; }
it("can save exploration without a goal and creates no learning result", async () => { const api = client(); await render(api); expect(api.note).not.toHaveBeenCalled(); await act(async () => button("保存理解与关联").click()); expect(api.note).toHaveBeenCalledWith(expect.objectContaining({ text: "我的理解", courseId: null, goalId: null, requirementId: null, origin: null })); expect(host.textContent).toContain("笔记已保存"); expect(host.textContent).toContain("不作为学习成绩"); });
it("keeps the original unknown atomic-save request across remount and a rejected retry", async () => { const { LearningAssetLinkRequestError } = await import("./learning-asset-link-client"); const api = client(); vi.mocked(api.note).mockRejectedValueOnce(new TypeError("lost")).mockRejectedValueOnce(new LearningAssetLinkRequestError("请恢复登录", 401)); await render(api); await act(async () => button("保存理解与关联").click()); const original = vi.mocked(api.note).mock.calls[0]; await act(async () => root.unmount()); root = createRoot(host); await render(api); await act(async () => button("重新确认这次笔记保存").click()); expect(host.textContent).toContain("保存结果待确认"); await act(async () => button("重新确认这次笔记保存").click()); expect(vi.mocked(api.note).mock.calls[2]).toEqual(original); });
it("preserves the original activity block/version without sending a navigation URL", async () => { const api = client(); await render(api, { label: "原题", fragment: "漏看条件", courseId: id, activityId: id, blockId: id, contentVersion: 2 } as never); await act(async () => button("保存理解与关联").click()); const input = vi.mocked(api.note).mock.calls[0]![0]; expect(input.origin).toMatchObject({ activityId: id, blockId: id, contentVersion: 2 }); expect(input).not.toHaveProperty("returnHref"); });
it("does not send when storage cannot retain the atomic request", async () => { const api = client(); await render(api); vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("quota"); }); await act(async () => button("保存理解与关联").click()); expect(api.note).not.toHaveBeenCalled(); expect(host.textContent).toContain("尚未提交"); vi.restoreAllMocks(); });
it("blocks malformed persisted save receipts instead of sending a replacement note", async () => { sessionStorage.setItem('aistudy:atomic-study-note:verified-note-owner:[null,null,null,null,null,null,null,null,null]', '{"request":broken'); const api = client(); await render(api, {}); expect(host.textContent).toContain("原保存信息无法读取"); expect(button("保存理解与关联").disabled).toBe(true); expect(api.note).not.toHaveBeenCalled(); });
