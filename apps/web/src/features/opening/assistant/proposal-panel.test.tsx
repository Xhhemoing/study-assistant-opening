// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssistantProposalRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";

const learning = vi.hoisted(() => ({ listObservations: vi.fn() }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => learning }));
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
import { ProposalPanel } from "./proposal-panel";
import { useProposalPanel, type ProposalPanelModel } from "./use-proposal-panel";

const courseId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const otherCourse = "33333333-3333-4333-8333-333333333333";
const draft = { id: courseId, sourceTurnId: turnId, version: 1, status: "draft", tool: { name: "propose_note", arguments: { title: "保留建议", text: "观察读取失败也能看到" } }, prepared: null, result: null } as AssistantProposalRecord;
let host: HTMLDivElement, root: Root, model: ProposalPanelModel;
type Input = Parameters<typeof useProposalPanel>[0] & { panelKey?: string; draftsOnly?: boolean };
function Harness({ panelKey = "main", draftsOnly = false, ...props }: Input) {
  model = useProposalPanel(props);
  return <ProposalPanel key={panelKey} model={model} draftsOnly={draftsOnly} />;
}
function apiWith(rows: AssistantProposalRecord[] = []) {
  return {
    listAssistantProposals: vi.fn(async () => rows),
    proposeAssistantAction: vi.fn(async () => draft),
    decideAssistantProposal: vi.fn(async () => ({ ...draft, status: "accepted" })),
    getToday: vi.fn(async () => ({ acceptedVersion: 7 })),
  };
}
async function render(api: ReturnType<typeof apiWith>, extra: Partial<Omit<Input, "api">> = {}) {
  await act(async () => root.render(<Harness api={api as unknown as OpeningApi} sourceTurnId={turnId} courseId={null} enabled {...extra} />));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  learning.listObservations.mockReset().mockResolvedValue([]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("hides plan changes and grade disputes without a bound course", async () => {
  await render(apiWith());
  const options = Array.from(host.querySelectorAll("option")).map(option => option.value);
  expect(options).not.toContain("propose_plan_change");
  expect(options).not.toContain("flag_dispute");
});

it("keeps successfully read draft proposals when observations are unavailable", async () => {
  learning.listObservations.mockRejectedValue(new Error("观察503"));
  await render(apiWith([draft]), { courseId });
  expect(host.textContent).toContain("观察读取失败也能看到");
  expect(model.draftCount).toBe(1);
  expect(model.readError).toBeNull();
  expect(model.observationError).toContain("观察503");
});

it("does not read while disabled and keeps one request and form owner when the panel moves", async () => {
  const api = apiWith([draft]);
  await render(api, { enabled: false });
  expect(api.listAssistantProposals).not.toHaveBeenCalled();
  expect(learning.listObservations).not.toHaveBeenCalled();
  await render(api);
  await act(async () => { model.setTitle("尚未发送的标题"); model.setText("保留输入"); });
  await render(api, { panelKey: "sidebar" });
  expect(api.listAssistantProposals).toHaveBeenCalledOnce();
  expect(host.querySelector("input")?.value).toBe("尚未发送的标题");
  expect(host.querySelector("textarea")?.value).toBe("保留输入");
});

it("counts only drafts and closes the last draft after its original version is decided", async () => {
  const api = apiWith([draft, { ...draft, id: otherCourse, status: "rejected" }]);
  api.listAssistantProposals.mockResolvedValueOnce([draft]).mockResolvedValue([{ ...draft, status: "accepted" }]);
  await render(api, { draftsOnly: true });
  expect(model.draftCount).toBe(1);
  await act(async () => model.decide(draft, "accept"));
  expect(api.decideAssistantProposal).toHaveBeenCalledWith(courseId, {
    expectedVersion: 1, action: "accept", clientKey: `proposal-decision:${courseId}:1:accept`,
  });
  expect(model.draftCount).toBe(0);
  expect(host.querySelector("li")).toBeNull();
});

it("keeps a failed read visible and recovers through the panel retry button", async () => {
  const api = apiWith([draft]);
  api.listAssistantProposals.mockRejectedValueOnce(new Error("建议503"));
  await render(api);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("建议503");
  const retry = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "重新读取建议")!;
  await act(async () => retry.click());
  expect(model.readError).toBeNull();
  expect(model.draftCount).toBe(1);
  expect(host.textContent).toContain("观察读取失败也能看到");
});

it("ignores old course proposal and observation responses after a new scope loads", async () => {
  const proposals = deferred<AssistantProposalRecord[]>();
  const observations = deferred<never[]>();
  const api = apiWith([]);
  api.listAssistantProposals.mockReturnValueOnce(proposals.promise);
  learning.listObservations.mockReturnValueOnce(observations.promise);
  await render(api, { courseId });
  await render(api, { courseId: otherCourse });
  expect(model.rows).toEqual([]);
  await act(async () => { proposals.resolve([draft]); observations.reject(new Error("旧观察503")); });
  expect(model.rows).toEqual([]);
  expect(model.draftCount).toBe(0);
  expect(model.observationError).toBeNull();
  expect(model.loading).toBe(false);
});

it("does not show a late failed read from a previous source turn", async () => {
  const old = deferred<AssistantProposalRecord[]>();
  const api = apiWith([draft]);
  api.listAssistantProposals.mockReturnValueOnce(old.promise);
  await render(api);
  await render(api, { sourceTurnId: otherCourse });
  await act(async () => old.reject(new Error("旧建议503")));
  expect(model.readError).toBeNull();
  expect(model.draftCount).toBe(1);
});

it("retries the same uncertain proposal intent and prevents simultaneous duplicate sends", async () => {
  const api = apiWith();
  api.proposeAssistantAction.mockRejectedValueOnce(new Error("提交结果未知"));
  await render(api);
  await act(async () => { model.setTitle("笔记标题"); model.setText("笔记内容"); });
  await act(async () => { await Promise.all([model.propose(), model.propose()]); });
  expect(api.proposeAssistantAction).toHaveBeenCalledOnce();
  await act(async () => model.propose());
  expect(api.proposeAssistantAction).toHaveBeenCalledTimes(2);
  const inputs = api.proposeAssistantAction.mock.calls as unknown as Array<[unknown]>;
  expect(inputs[1]?.[0]).toEqual(inputs[0]?.[0]);
  expect(inputs[0]?.[0]).toMatchObject({ sourceTurnId: turnId, clientKey: expect.stringMatching(/^assistant-proposal:/), tool: { name: "propose_note", arguments: { title: "笔记标题", text: "笔记内容" } } });
});

it.each(["propose_plan_change", "flag_dispute"] as const)("blocks stale %s selection without a course and resets it when course disappears", async kind => {
  const api = apiWith();
  await render(api, { courseId });
  await act(async () => model.setKind(kind));
  await render(api);
  expect(model.kind).toBe("propose_note");
  await act(async () => model.setKind(kind));
  await act(async () => model.propose());
  expect(api.getToday).not.toHaveBeenCalled();
  expect(api.proposeAssistantAction).not.toHaveBeenCalled();
  expect(model.message).toContain("课程");
});

it("does not send a plan after its course changes during version lookup", async () => {
  const today = deferred<{ acceptedVersion: number }>();
  const api = apiWith(); api.getToday.mockReturnValueOnce(today.promise);
  await render(api, { courseId });
  await act(async () => model.setKind("propose_plan_change"));
  let action!: Promise<void>;
  await act(async () => { action = model.propose(); });
  await render(api);
  await act(async () => { today.resolve({ acceptedVersion: 8 }); await action; });
  expect(api.proposeAssistantAction).not.toHaveBeenCalled();
  expect(model.message).toBe("");
  expect(model.busy).toBe(false);
});

it("retains existing course-dependent draft review when the current conversation has no course", async () => {
  const dispute = { ...draft, tool: { name: "flag_dispute", arguments: { rootObservationId: courseId, expectedHead: turnId, reason: "保留审核入口" } } } as AssistantProposalRecord;
  const api = apiWith([dispute]);
  await render(api, { sourceTurnId: null });
  expect(host.querySelector("form")).toBeNull();
  expect(host.textContent).toContain("保留审核入口");
  const reject = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "不采用")!;
  await act(async () => reject.click());
  expect(api.decideAssistantProposal).toHaveBeenCalledWith(courseId, expect.objectContaining({ action: "reject" }));
});

it("preserves the uncertain intent key across temporarily disabled conversation reloads", async () => {
  const api = apiWith();
  api.proposeAssistantAction.mockRejectedValueOnce(new Error("提交结果未知"));
  await render(api);
  await act(async () => { model.setTitle("同一笔记"); model.setText("同一内容"); });
  await act(async () => model.propose());
  await render(api, { enabled: false });
  await render(api);
  await act(async () => model.propose());
  const inputs = api.proposeAssistantAction.mock.calls as unknown as Array<[unknown]>;
  expect(inputs).toHaveLength(2);
  expect(inputs[1]?.[0]).toEqual(inputs[0]?.[0]);
});

it("ignores reads from the previous enabled interval after reactivation", async () => {
  const old = deferred<AssistantProposalRecord[]>();
  const api = apiWith([]);
  api.listAssistantProposals.mockReturnValueOnce(old.promise);
  await render(api);
  await render(api, { enabled: false });
  await render(api);
  await act(async () => old.resolve([draft]));
  expect(model.rows).toEqual([]);
  expect(model.draftCount).toBe(0);
  expect(model.readError).toBeNull();
});

it("does not let a late success before disabling erase the reactivated uncertain intent", async () => {
  const old = deferred<AssistantProposalRecord>();
  const api = apiWith();
  api.proposeAssistantAction.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error("新重试结果未知"));
  await render(api);
  await act(async () => { model.setTitle("同一笔记"); model.setText("同一内容"); });
  let first!: Promise<void>;
  await act(async () => { first = model.propose(); });
  await render(api, { enabled: false });
  await render(api);
  await act(async () => model.propose());
  await act(async () => { old.resolve(draft); await first; });
  expect(model.message).toContain("新重试结果未知");
  await act(async () => model.propose());
  const inputs = api.proposeAssistantAction.mock.calls as unknown as Array<[unknown]>;
  expect(inputs).toHaveLength(3);
  expect(inputs[1]?.[0]).toEqual(inputs[0]?.[0]);
  expect(inputs[2]?.[0]).toEqual(inputs[0]?.[0]);
});
