// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { StudyContextTools } from "./study-context-tools";
import { editSelfExplanation, freezeSelfExplanation, readSelfExplanation } from "./self-explanation-draft";
import type { LearningAttempt } from "@aistudy/contracts";

const probe = vi.hoisted(() => ({ assistant: vi.fn() }));
vi.mock("../assistant/assistant-view", () => ({ AssistantView: (props: unknown) => { probe.assistant(props); return createElement("div", { "data-assistant": true }); } }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); sessionStorage.clear(); publishVerifiedSessionIdentity({ id: "A", workspaceId: "workspace" }); probe.assistant.mockClear(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
async function click(text: string) { await act(async () => button(text).click()); }

it("exposes the real entry even in notes section, hands off only on explicit check and preserves attempt props", async () => {
  const context = { courseId: crypto.randomUUID(), label: "矩阵", sourceId: crypto.randomUUID(), sourceVersion: 2 };
  const attempt = { sourceIds: [context.sourceId] } as LearningAttempt;
  await act(async () => root.render(createElement(StudyContextTools, { context, section: "notes", isQuestion: true, learningAttempt: attempt, initialQuestion: "原输入" })));
  await click("我的理解");
  await act(async () => { editSelfExplanation(context, { original: "我自己的原话" }); freezeSelfExplanation(context); });
  expect(probe.assistant.mock.lastCall?.[0].promptRequest).toBeUndefined();
  await click("请帮我检查这段理解");
  const props = probe.assistant.mock.lastCall![0];
  expect(props.promptRequest.text).toContain("我自己的原话");
  expect(props.learningAttempt).toBe(attempt); expect(props.initialDraft).toBe("原输入"); expect(props.initialSourceIds).toEqual(attempt.sourceIds);
  expect(host.querySelector("[data-assistant]")?.closest("[hidden]")).toBeNull();
  await click("返回笔记");
  expect(host.querySelector('textarea[id$="-text"]')?.closest("[hidden]")).toBeNull();
  await click("我的理解");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[id$="-original"]')?.readOnly).toBe(true);
  await click("开始新记录"); await click("取消");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[id$="-original"]')?.value).toBe("我自己的原话");
  await click("开始新记录"); await click("确认开始新记录");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[id$="-original"]')?.value).toBe("");
});

it.each([{ isQuestion: true }, { questionBlockedReason: "权限不足" }])("does not bypass existing canAsk restriction: %j", async restriction => {
  const context = { label: "题目", courseId: crypto.randomUUID() };
  await act(async () => root.render(createElement(StudyContextTools, { context, ...restriction })));
  await click("我的理解");
  await act(async () => { editSelfExplanation(context, { original: "先记录" }); freezeSelfExplanation(context); });
  expect(button("请帮我检查这段理解").disabled).toBe(true);
  await click("请帮我检查这段理解");
  expect(probe.assistant).not.toHaveBeenCalled();
  expect(button("保存为用户笔记").disabled).toBe(false);
});

it("clears the check override when explicitly choosing ordinary notes", async () => {
  const context = { courseId: crypto.randomUUID(), label: "切换", fragment: "材料不是原话" };
  await act(async () => root.render(createElement(StudyContextTools, { context })));
  await click("我的理解");
  await act(async () => { editSelfExplanation(context, { original: "用户解释" }); freezeSelfExplanation(context); });
  // Includes fragment: the subscription must normalize it exactly like draft IO.
  expect(host.querySelector<HTMLTextAreaElement>('textarea[id$="-original"]')?.value).toBe("用户解释");
  await click("请帮我检查这段理解"); await click("记笔记");
  expect(host.querySelector('textarea[id$="-text"]')?.closest("[hidden]")).toBeNull();
  expect(host.querySelector("[data-assistant]")?.closest("[hidden]")).not.toBeNull();
});

it("keeps escaped overflow fully copyable and never saves stale input", async () => {
  const context = { courseId: crypto.randomUUID(), label: "超限" };
  await act(async () => root.render(createElement(StudyContextTools, { context })));
  await click("我的理解");
  await act(async () => { editSelfExplanation(context, { original: '"'.repeat(9000) }); freezeSelfExplanation(context); });
  const revision = host.querySelector<HTMLTextAreaElement>('textarea[id$="-revision"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(revision, '\\'.repeat(9000));
    revision.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(revision.value).toBe('\\'.repeat(9000));
  expect(host.textContent).toContain("当前输入完整保留");
  expect(button("保存为用户笔记").disabled).toBe(true);
  expect(readSelfExplanation(context).record?.revision).toBe("");
  await click("提问"); await click("我的理解");
  expect(revision.value).toBe('\\'.repeat(9000));
});

it("rebinds panel subscriptions on A/B same-context switch and blocks unverified UI", async () => {
  const context = { courseId: crypto.randomUUID(), label: "账号" };
  const render = () => root.render(createElement(StudyContextTools, { context }));
  await act(async () => render()); await click("我的理解");
  await act(async () => { editSelfExplanation(context, { original: "A的原稿" }); });
  await act(async () => { publishVerifiedSessionIdentity({ id: "B", workspaceId: "workspace" }); render(); });
  expect(host.querySelector<HTMLTextAreaElement>('textarea[id$="-original"]')?.value).toBe("");
  await act(async () => { editSelfExplanation(context, { original: "B的原稿" }); });
  expect(host.querySelector<HTMLTextAreaElement>('textarea[id$="-original"]')?.value).toBe("B的原稿");
  await act(async () => { publishVerifiedSessionIdentity({ id: "A", workspaceId: "workspace" }); render(); });
  expect(host.querySelector<HTMLTextAreaElement>('textarea[id$="-original"]')?.value).toBe("A的原稿");
  await act(async () => { const cleanup = publishVerifiedSessionIdentity({ id: "A", workspaceId: "workspace" }); cleanup(); render(); });
  expect(host.textContent).toContain("尚未验证登录身份");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[id$="-original"]')?.readOnly).toBe(true);
  expect(host.querySelector<HTMLTextAreaElement>('textarea[id$="-original"]')?.value).toBe("");
  expect(button("保存为用户笔记").disabled).toBe(true);
});
