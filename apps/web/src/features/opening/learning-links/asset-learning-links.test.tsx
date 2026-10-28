// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { LearningAssetLinkClient } from "./learning-asset-link-client";
import { AssetLearningLinks } from "./asset-learning-links";
vi.mock("../../auth/session-identity", () => ({ getVerifiedSessionNamespace: () => "verified-link-owner" }));
vi.mock("./learning-link-target-form", () => ({ LearningLinkTargetForm: () => <p>明确选择课程目标</p> }));
const id = "11111111-1111-4111-8111-111111111111";
const view = { link: { id, assetType: "document", assetId: id, assetVersion: null, courseId: id, goalId: id, requirementId: id, purpose: "understanding", status: "active", revision: 2 }, courseTitle: "线代", goalTitle: "理解方法", requirementTitle: "解释推理", originAvailable: true, originHref: `/opening/courses/${id}/study?activity=${id}&block=${id}&contentVersion=2`, sourceHrefs: [{ label: "课件 · v1", href: `/opening/library?source=${id}&version=1` }], warnings: [] };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function client(value = view) { return { list: vi.fn(async () => ({ links: [value] })), create: vi.fn(async () => value), detach: vi.fn(async () => ({ ...value, link: { ...value.link, status: "detached", revision: 3 } })) } as unknown as LearningAssetLinkClient; }
async function render(api: LearningAssetLinkClient) { await act(async () => root.render(<AssetLearningLinks assetType="document" assetId={id} client={api} />)); }
function button(text: string) { const value = [...host.querySelectorAll("button")].find(node => node.textContent === text); if (!value) throw new Error(`missing ${text}`); return value; }
it("shows persisted targets and exact return/source hrefs without creating learning records", async () => { const api = client(); await render(api); expect(host.textContent).toContain("理解方法"); expect(host.querySelector('a[href*="contentVersion=2"]')).toBeTruthy(); expect(host.querySelector('a[href*="version=1"]')).toBeTruthy(); expect(api.create).not.toHaveBeenCalled(); });
it("keeps unavailable or restored history explainable without a fake resume link", async () => { await render(client({ ...view, link: { ...view.link, status: "detached" }, originAvailable: false, originHref: null, warnings: ["原活动位置不可用，历史关联保留。"] } as never)); expect(host.textContent).toContain("历史关联保留"); expect(host.querySelector('a[href*="activity="]')).toBeNull(); });
it("does not repeat an unknown detach with a new revision after a rejected retry", async () => { const { LearningAssetLinkRequestError } = await import("./learning-asset-link-client"); const api = client(); vi.mocked(api.detach).mockRejectedValueOnce(new TypeError("lost")).mockRejectedValueOnce(new LearningAssetLinkRequestError("请恢复登录", 401)); await render(api); await act(async () => button("解除这条关联").click()); const original = vi.mocked(api.detach).mock.calls[0]; await act(async () => button("重新确认这次关联操作").click()); expect(host.textContent).toContain("关联结果待确认"); await act(async () => button("重新确认这次关联操作").click()); expect(vi.mocked(api.detach).mock.calls[2]).toEqual(original); });
it("blocks an unreadable stored association command rather than assuming no pending write", async () => { sessionStorage.setItem(`aistudy:learning-link-command:verified-link-owner:document:${id}`, '{"kind":"create",broken'); const api = client(); await render(api); expect(host.textContent).toContain("上次关联的信息无法读取"); expect(button("关联课程、目标或要求").disabled).toBe(true); expect(api.create).not.toHaveBeenCalled(); });
