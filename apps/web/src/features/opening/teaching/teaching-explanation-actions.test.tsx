// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";
import { TeachingBlockItem } from "./teaching-block-item";
vi.mock("./block-renderer", () => ({ BlockRenderer: () => <p>需要理解的原文</p> }));
vi.mock("./inline-explain", () => ({ InlineExplain: () => <span>保存这段讲解</span> }));

it("reveals four contextual actions by keyboard without advancing or rewriting the lesson", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const ask = vi.fn(), command = vi.fn(), success = vi.fn();
  try {
    await act(async () => root.render(<TeachingBlockItem block={{ blockId: "block-1", blockType: "text", role: "teach", position: 0, content: { text: "需要理解的原文" } }}
      focusStatus="current" showCommands={false} activityId="activity-1" contentVersion={2} pathVersion={3} returnDisabled whyAvailable={false}
      api={{ postTeachingCommand: command } as unknown as OpeningApi} onSuccess={success} onConflict={() => undefined} onReread={() => undefined}
      explanationContext={{ activityId: "activity-1", blockId: "block-1", contentVersion: 2 }} onAskExplanation={ask} />));
    const region = host.querySelector<HTMLElement>('[aria-label="调整本段讲解"]')!;
    expect(region).not.toBeNull();
    expect(host.querySelector('[data-explanation-actions]')?.closest('[hidden]')).not.toBeNull();
    await act(async () => region.focus());
    const actions = [...host.querySelectorAll<HTMLButtonElement>('[data-explanation-actions] button')];
    expect(actions.map(button => button.textContent)).toEqual(["我没懂", "举个例子", "讲快点", "讲细点"]);
    expect(actions[0]!.closest('[hidden]')).toBeNull();
    await act(async () => actions[1]!.click());
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]![0]).toContain("需要理解的原文");
    expect(ask.mock.calls[0]![0]).toContain("例子");
    expect(command).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled();
    expect(host.querySelector("p")?.textContent).toBe("需要理解的原文");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
