// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ActivitySpecClientInit, TeachingActivity, TeachingCommandRequest, TeachingCommandResponse, TeachingCommandSuccess } from "@aistudy/contracts";
import { generateTeachingWorkedExample, type WorkedExampleBody } from "../../../../../../packages/database/src/repositories/teaching-worked-example";
import { TeachingWorkspace } from "./teaching-workspace";
import type { OpeningApi } from "../client/api";
import {
  BlockCommands,
  BlockCommandsBarView,
  SKIP_HONESTY_COPY,
  TEACHING_COMMAND_KINDS,
  branchStackDepth,
  conflictRequiresReread,
  isBranchStackEmpty,
  newTeachingCommandClientKey,
  teachingCommandConflictLabel,
  teachingCommandKindLabel,
} from "./block-commands";

const BID = "44444444-4444-4444-8444-444444444444";

function whyResult(contentVersion: number, summary: string): TeachingCommandSuccess {
  return { ok: true, kind: "why", activityId: BID, contentVersion, pathVersion: 1, checkpointJson: {}, replayed: false, assist: { kind: "why", summary } };
}

describe("BlockCommands explanation provenance", () => {
  it("drops a v1 explanation when stale content is reread as v2 without remounting the toolbar", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const api = { postTeachingCommand: vi.fn().mockResolvedValueOnce(whyResult(1, "旧版的实际解释"))
      .mockResolvedValueOnce({ ok: false, conflict: "stale_content_version", message: "教学内容已更新", currentContentVersion: 2 })
      .mockResolvedValueOnce(whyResult(2, "新版的实际解释")) };
    const ask = vi.fn();
    function render(version: number) { root.render(createElement(BlockCommands, {
      activityId: BID, blockId: BID, contentVersion: version, returnDisabled: false, whyAvailable: true,
      api: api as unknown as OpeningApi, explanationContext: { activityId: BID, blockId: BID, contentVersion: version },
      onAskExplanation: ask, onReread: () => render(2),
    })); }
    const why = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "讲细点")!;
    try {
      await act(async () => render(1)); const originalButton = why();
      await act(async () => why().click()); expect(host.textContent).toContain("旧版的实际解释");
      await act(async () => why().click()); expect(host.textContent).not.toContain("旧版的实际解释");
      await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("重新读取教学内容"))!.click());
      expect(why()).toBe(originalButton); expect(host.querySelector("[data-anchor]")).toBeNull();
      await act(async () => why().click());
      expect(host.textContent).toContain("新版的实际解释"); expect(host.textContent).not.toContain("旧版的实际解释");
      await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "继续问")!.click());
      expect(ask).toHaveBeenCalledExactlyOnceWith("新版的实际解释");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("ignores a late v1 response and leaves the current v2 request pending until its own result", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    let first!: (value: TeachingCommandResponse) => void, second!: (value: TeachingCommandResponse) => void;
    const oldRequest = new Promise<TeachingCommandResponse>(resolve => { first = resolve; });
    const newRequest = new Promise<TeachingCommandResponse>(resolve => { second = resolve; });
    const api = { postTeachingCommand: vi.fn().mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest) };
    const success = vi.fn();
    const render = (version: number) => root.render(createElement(BlockCommands, {
      activityId: BID, blockId: BID, contentVersion: version, returnDisabled: false, whyAvailable: true,
      api: api as unknown as OpeningApi, onSuccess: success,
      explanationContext: { activityId: BID, blockId: BID, contentVersion: version }, onAskExplanation() {},
    }));
    const why = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "讲细点")!;
    try {
      await act(async () => render(1)); await act(async () => why().click());
      await act(async () => render(2)); await act(async () => why().click());
      await act(async () => first(whyResult(1, "迟到的旧版解释")));
      expect(success).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("迟到的旧版解释");
      expect(why().disabled).toBe(true); expect(host.querySelector("[data-anchor]")).toBeNull();
      await act(async () => second(whyResult(2, "当前请求的解释")));
      expect(host.textContent).toContain("当前请求的解释"); expect(why().disabled).toBe(false);
      expect(success).toHaveBeenCalledExactlyOnceWith(whyResult(2, "当前请求的解释"));
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});

describe("explicit free worked-example action", () => {
  it("does not describe an already-executed operation as an unpublished free refusal", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"), root = createRoot(host);
    const message = "此操作已执行，请重新读取已保存的例题；不会自动再生成。";
    const api = { postTeachingCommand: vi.fn().mockResolvedValue({ ok: false, conflict: "validation", message }) };
    try {
      await act(async () => root.render(createElement(BlockCommands, { activityId: BID, blockId: BID, contentVersion: 1,
        returnDisabled: true, exampleAvailable: true, api: api as unknown as OpeningApi })));
      await act(async () => freeExampleButton(host).click());
      expect(host.querySelector('[data-command-conflict="validation"]')?.textContent).toContain(message);
      expect(host.textContent).not.toContain("本次未生成新例题");
      expect(api.postTeachingCommand).toHaveBeenCalledOnce();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("never posts on mount/reload and submits at most once for a synchronous double click", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    let finish!: (result: TeachingCommandResponse) => void;
    const api = { postTeachingCommand: vi.fn(() => new Promise<TeachingCommandResponse>(resolve => { finish = resolve; })) };
    try {
      await act(async () => root.render(createElement(BlockCommands, { activityId: BID, blockId: BID, contentVersion: 1,
        returnDisabled: true, exampleAvailable: true, api: api as unknown as OpeningApi })));
      expect(api.postTeachingCommand).not.toHaveBeenCalled();
      const button = [...host.querySelectorAll("button")].find(button => button.textContent === "生成新例题（免费）")!;
      await act(async () => { button.click(); button.click(); });
      expect(api.postTeachingCommand).toHaveBeenCalledTimes(1);
      expect(api.postTeachingCommand.mock.calls[0]).toMatchObject([BID, { kind: "example", blockId: BID, expectedVersion: 1 }]);
      await act(async () => finish({ ok: false, conflict: "validation", message: "不支持" }));
      expect(api.postTeachingCommand).toHaveBeenCalledTimes(1);
      await act(async () => root.render(createElement(BlockCommands, { activityId: BID, blockId: BID, contentVersion: 1,
        returnDisabled: true, exampleAvailable: true, api: api as unknown as OpeningApi })));
      expect(api.postTeachingCommand).toHaveBeenCalledTimes(1);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});

// Real workspace -> real toolbar -> API test double -> actual candidate helper/generators.
// The double only models the command response envelope/append; it does NOT test PG,
// transactions, fees, receipts or HTTP. No backend result text is canned here.
async function withExampleWorkspace(original: string, history: string[], run: (host: HTMLDivElement,
  post: ReturnType<typeof vi.fn<OpeningApi["postTeachingCommand"]>>, generated: WorkedExampleBody[]) => Promise<void>, role: "example" | "teach" = "example") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected HTTP in component unit test"); }));
  // jsdom lacks the non-modal dialog methods; keep the real tools panel and controls.
  const dialogMethods = ["show", "close"] as const;
  const descriptors = dialogMethods.map(method => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method));
  for (const method of dialogMethods) Object.defineProperty(HTMLDialogElement.prototype, method, {
    configurable: true, value(this: HTMLDialogElement) { this.open = method === "show"; },
  });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const ISO = "2026-10-11T04:00:00.000Z";
  const activity: TeachingActivity = { id: BID, workspaceId: BID, ownerUserId: BID, courseId: null,
    status: "active", generateStatus: "ready", intentKind: "topic", intentSummary: "例题学习",
    sourceIds: [], pathVersion: 1, contentVersion: 1, clientKey: "unit-example", createdAt: ISO, updatedAt: ISO };
  let init: ActivitySpecClientInit = { id: BID, activityId: BID, teachingUnitId: BID, documentId: BID,
    revisionNumber: 1, blockOrder: [{ blockId: BID, blockType: role === "example" ? "example" : "text", role, position: 0 }],
    sourceRefs: [], goals: [], verificationStatus: "structure_ok", generationConfig: {}, version: 1,
    createdAt: ISO, updatedAt: ISO, contentVersion: 1,
    blocks: [{ blockId: BID, blockType: role === "example" ? "example" : "text", role, position: 0, content: { text: original } }],
    checkpointJson: { currentBlockId: BID, drafts: [{ blockId: BID, draftText: "保留的笔记" }] } };
  const generated: WorkedExampleBody[] = [];
  const post = vi.fn<OpeningApi["postTeachingCommand"]>(async (_id, request) => {
    const body = init.blocks.find(block => block.blockId === request.blockId)?.content as { text: string };
    const next = generateTeachingWorkedExample(body.text, history);
    if (!next) return { ok: false, conflict: "validation", message: "未生成新例题：输入不受支持或本题族新题已用完。原题与学习记录保持不变。" };
    generated.push(next); history.push(next.text);
    const id = `55555555-5555-4555-8555-${String(generated.length).padStart(12, "0")}`;
    const block = { blockId: id, blockType: "example" as const, role: "example" as const, position: init.blocks.length, content: { ...next, generated: true } };
    init = { ...init, contentVersion: init.contentVersion + 1, revisionNumber: init.revisionNumber + 1,
      blocks: [...init.blocks, block], blockOrder: [...init.blockOrder, block],
      checkpointJson: { ...init.checkpointJson, currentBlockId: id } };
    return { ok: true, kind: "example", activityId: BID, contentVersion: init.contentVersion,
      pathVersion: 1, replayed: false, checkpointJson: init.checkpointJson!, clientInit: init };
  });
  try {
    await act(async () => root.render(createElement(TeachingWorkspace, { activity, clientInit: init,
      sourceNameById: {}, contextualTools: createElement("p", {}, "测试辅导区"), api: { postTeachingCommand: post } as unknown as OpeningApi })));
    expect(post).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "工具")!.click());
    await act(async () => [...host.querySelectorAll<HTMLElement>("summary")].find(summary => summary.textContent === "学习帮助")!.click());
    expect(post).not.toHaveBeenCalled();
    await run(host, post, generated);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); host.remove();
    dialogMethods.forEach((method, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    });
    vi.unstubAllGlobals();
  }
}
const freeExampleButton = (host: HTMLDivElement) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "生成新例题（免费）")!;

describe("actual workspace free-example entry with candidate generators", () => {
  it.each([
    "计算 1/2 + 1/3",
    "求函数 f(x)=1/2x^2 - 1/3x 的导数。",
    "求曲线 y=f(x)=x^2 在 x=1/2 处的切线方程。",
    "计算定积分 ∫[0, 2] (1/2x^2 - 1/3) dx。",
  ])("shows complete generated stem, exact answer and every step for %s", async original => {
    await withExampleWorkspace(original, [], async (host, post, generated) => {
      expect(freeExampleButton(host).closest("details")?.open).toBe(true);
      expect(host.textContent).toContain("0–5 次多项式");
      expect(host.textContent).toContain("不是独立作答、未见题或掌握证据");
      expect(host.textContent).toContain("不支持通用高数、极限、体积");
      await act(async () => freeExampleButton(host).click());
      expect(post).toHaveBeenCalledOnce();
      const request: TeachingCommandRequest = post.mock.calls[0]![1];
      expect(request).toEqual({ kind: "example", blockId: BID, expectedVersion: 1, expectedPathVersion: 1, clientKey: expect.stringMatching(/^cmd-/) });
      expect(JSON.stringify(request)).not.toContain(original);
      const next = generated[0]!;
      expect(next).toBeDefined(); expect(next.stem).not.toBe(original); expect(next.steps.length).toBeGreaterThan(0);
      const examples = [...host.querySelectorAll<HTMLElement>('[data-catalog="example"]')];
      expect(examples).toHaveLength(2);
      expect(examples[0]!.textContent).toContain(original);
      // Inspect actual rendered prose, not response metadata or hidden assistant context.
      expect(examples[1]!.textContent).toContain(next.stem);
      expect(examples[1]!.textContent).toContain(`答案：${next.answer}`);
      for (const step of next.steps) expect(examples[1]!.textContent).toContain(step);
      if (original.startsWith("计算定积分")) expect(examples[1]!.textContent).toContain("不是几何面积");
      const tools = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "工具")!;
      await act(async () => tools().click());
      expect(examples[1]!.closest("[hidden]")).toBeNull();
      await act(async () => tools().click());
      await act(async () => freeExampleButton(host).click());
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[1]![1]).toMatchObject({ expectedVersion: 2, expectedPathVersion: 1 });
      expect(generated[1]!.stem).not.toBe(next.stem);
    });
  });

  it.each(["求极限 lim x→0 sin(x)/x", "求旋转体体积", "求函数 f(x)=sin(x) 的导数。", "求函数 f(x)=x^6 的导数。",
    "求函数 f(x)=13*x 的导数。", "计算定积分 ∫[0, 11] (x) dx。", "请计算\n求函数 f(x)=x^2 的导数。"])("refuses %s without automatic retries or content publication", async original => {
    await withExampleWorkspace(original, [], async (host, post, generated) => {
      await act(async () => freeExampleButton(host).click());
      expect(generated).toHaveLength(0); expect(post).toHaveBeenCalledOnce();
      const alert = host.querySelector('[data-command-conflict="validation"]');
      expect(alert?.textContent).toContain("输入不受支持或本题族新题已用完");
      expect(alert?.textContent).toContain("不收费");
      expect(alert?.textContent).toContain("不会自动重试或转为付费生成");
      expect(host.querySelectorAll('[data-catalog="example"]')).toHaveLength(1);
      expect(host.querySelector('[data-catalog="example"]')?.textContent).toContain(original);
      expect(freeExampleButton(host).disabled).toBe(false);
    });
  });

  it.each(["计算 1/2 + 1/3", "求函数 f(x)=x^2 的导数。", "求曲线 y=f(x)=x^2 在 x=1 处的切线方程。", "计算定积分 ∫[0, 2] (x^2 - 1) dx。"]) (
    "refuses actual exhausted history for %s", async original => {
      const history: string[] = [];
      for (let i = 0; i < 20; i++) {
        const next = generateTeachingWorkedExample(original, history);
        if (!next) break;
        history.push(next.text);
      }
      expect(history.length).toBeGreaterThan(0); expect(generateTeachingWorkedExample(original, history)).toBeNull();
      await withExampleWorkspace(original, history, async (host, post, generated) => {
        await act(async () => freeExampleButton(host).click());
        expect(post).toHaveBeenCalledOnce(); expect(generated).toHaveLength(0);
        expect(host.querySelector('[data-command-conflict="validation"]')?.textContent).toContain("不收费");
        expect(host.querySelectorAll('[data-catalog="example"]')).toHaveLength(1);
      });
    });

  it("renders the entire finite integral supply, including rational answers, then refuses on the next explicit click", async () => {
    await withExampleWorkspace("计算定积分 ∫[0, 2] (x^2 - 1) dx。", [], async (host, post, generated) => {
      for (let i = 0; i < 12; i++) {
        await act(async () => freeExampleButton(host).click());
        const next = generated[i]!;
        expect(next).toBeDefined();
        const rendered = [...host.querySelectorAll('[data-catalog="example"]')].at(-1)!;
        expect(rendered.textContent).toContain(next.stem);
        expect(rendered.textContent).toContain(`答案：${next.answer}`);
        for (const step of next.steps) expect(rendered.textContent).toContain(step);
      }
      expect(generated.some(body => /\d+\/\d+/.test(body.answer))).toBe(true);
      expect(new Set(generated.map(body => body.stem)).size).toBe(12);
      await act(async () => freeExampleButton(host).click());
      expect(generated).toHaveLength(12); expect(post).toHaveBeenCalledTimes(13);
      expect(host.querySelector('[data-command-conflict="validation"]')?.textContent).toContain("不收费");
      expect(host.querySelectorAll('[data-catalog="example"]')).toHaveLength(13);
    });
  });

  it("does not offer free generation for a non-example block", async () => {
    await withExampleWorkspace("求函数 f(x)=x^2 的导数。", [], async (host, post) => {
      expect(freeExampleButton(host)).toBeUndefined(); expect(post).not.toHaveBeenCalled();
    }, "teach");
  });
});

describe("branch stack helpers", () => {
  it("reads depth and empty from checkpoint", () => {
    expect(branchStackDepth(undefined)).toBe(0);
    expect(isBranchStackEmpty({})).toBe(true);
    expect(
      branchStackDepth({
        branchStack: [{ frameId: "x" }, { frameId: "y" }],
      }),
    ).toBe(2);
    expect(isBranchStackEmpty({ branchStack: [{ frameId: "x" }] })).toBe(false);
  });
});

describe("command labels / conflict policy", () => {
  it("covers all 7 kinds", () => {
    expect(TEACHING_COMMAND_KINDS).toHaveLength(7);
    for (const kind of TEACHING_COMMAND_KINDS) {
      expect(teachingCommandKindLabel(kind).length).toBeGreaterThan(0);
    }
  });

  it("requires reread for CAS / generate conflicts; never documents LWW", () => {
    expect(conflictRequiresReread("stale_content_version")).toBe(true);
    expect(conflictRequiresReread("generate_in_flight")).toBe(true);
    expect(conflictRequiresReread("branch_stack_empty")).toBe(false);
    expect(teachingCommandConflictLabel("stale_content_version")).toMatch(/重新读取/);
    expect(SKIP_HONESTY_COPY).toMatch(/不会记为答错/);
  });

  it("mint clientKey length >= 8", () => {
    expect(newTeachingCommandClientKey().length).toBeGreaterThanOrEqual(8);
  });
});

describe("BlockCommandsBarView", () => {
  it("offers direct note and editable card actions on the actual delivered explanation", () => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, whyAvailable: true,
      assist: { kind: "why", summary: "先比较两组向量的方向。" },
      explanationContext: { activityId: BID, contentVersion: 2 }, onAskExplanation() {}, onCommand() {},
    }));
    expect(html).toContain(`data-anchor="${BID}"`);
    expect(html).toContain("先比较两组向量的方向。");
    for (const action of ["保存", "制成卡片", "继续问"]) expect(html).toContain(action);
  });
  it("keeps a confused acknowledgement separate from an actual supplemental explanation", () => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, assist: { kind: "confused", summary: "已记下这里需要讲清楚。" },
      explanationContext: { activityId: BID, contentVersion: 2 }, onAskExplanation() {}, onCommand() {},
    }));
    expect(html).toContain("已记下这里需要讲清楚。");
    expect(html).not.toContain("保存");
  });
  it("offers the same four explanation actions without branch or skip controls", () => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, onAskExplanation() {}, onCommand() {},
    }));
    for (const label of ["我没懂", "举个例子", "讲快点", "讲细点"]) expect(html).toContain(label);
    for (const legacy of ["分支栈为空", 'data-command-kind="branch"', 'data-command-kind="return"', 'data-command-kind="skip"']) expect(html).not.toContain(legacy);
  });

  it.each([{ disabled: true }, { busyKind: "example" }, { rereadBusy: true }] as const)("keeps action locking: %j", state => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, onAskExplanation() {}, onCommand() {}, ...state,
    }));
    expect((html.match(/<button[^>]*disabled/g) ?? []).length).toBe(4);
  });

  it("keeps conflict recovery visible and suppresses unusable rewrite actions without an assistant", () => {
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: true, onCommand() {}, onReread() {},
      conflict: { ok: false, conflict: "stale_content_version", message: "content changed", currentContentVersion: 3 },
    }));
    expect(html).toContain("我没懂");
    expect(html).not.toContain("举个例子");
    expect(html).not.toContain("讲快点");
    expect(html).toContain('data-command-conflict="stale_content_version"');
    expect(html).toContain("重新读取教学内容");
    expect(html).not.toContain("force overwrite");
  });

  it("does not surface English UUID why stubs as a delivered explanation", () => {
    const stub = `Why this block (text): revisit block ${BID}.`;
    const html = renderToStaticMarkup(createElement(BlockCommandsBarView, {
      blockId: BID, returnDisabled: false, whyAvailable: true, onCommand() {}, assist: { kind: "why", summary: stub },
    }));
    expect(html).toContain("讲细点");
    expect(html).not.toContain(stub);
    expect(html).not.toContain('data-command-assist="why"');
  });

  it("prepares actual contextual requests without rewriting or skipping the current lesson", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"), root = createRoot(host);
    const ask = vi.fn(), command = vi.fn();
    try {
      await act(async () => root.render(createElement(BlockCommandsBarView, {
        blockId: BID, returnDisabled: false, onCommand: command, onAskExplanation: ask,
        explanationContext: { activityId: BID, contentVersion: 2, fragment: "当前单元原文" },
      })));
      for (const button of host.querySelectorAll<HTMLButtonElement>("button")) await act(async () => button.click());
      expect(ask).toHaveBeenCalledTimes(4);
      expect(ask.mock.calls.every(call => String(call[0]).includes("当前单元原文"))).toBe(true);
      expect(command).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
  });
});
