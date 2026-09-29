import { Children, isValidElement, type KeyboardEvent, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PracticeItem } from "@aistudy/contracts";
import { AnswerInput } from "./answer-input";

const item: PracticeItem = {
  id: "11111111-1111-4111-8111-111111111111",
  syllabusPointId: "22222222-2222-4222-8222-222222222222",
  kind: "short_answer", stem: "写下你的理解", answer: "答案", hints: [],
  abilitySlice: "recall", estimatedMinutes: 5, contentVersion: 1,
};
function answerKeyHandler(node: ReactNode): ((event: KeyboardEvent<HTMLInputElement>) => void) | undefined {
  if (!isValidElement<{ children?: ReactNode; onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void }>(node)) return;
  if (node.type === "input") return node.props.onKeyDown;
  for (const child of Children.toArray(node.props.children)) {
    const handler = answerKeyHandler(child);
    if (handler) return handler;
  }
}

describe("practice answer keyboard submission", () => {
  it("keeps Chinese composition Enter in the input and submits only the finished answer", () => {
    const onSubmit = vi.fn();
    const preventDefault = vi.fn();
    const handler = answerKeyHandler(AnswerInput({ item, answer: "中文答案", disabled: false, onChange: vi.fn(), onSubmit }));
    expect(handler).toBeTypeOf("function");
    handler?.({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault } as unknown as KeyboardEvent<HTMLInputElement>);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    handler?.({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault } as unknown as KeyboardEvent<HTMLInputElement>);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
