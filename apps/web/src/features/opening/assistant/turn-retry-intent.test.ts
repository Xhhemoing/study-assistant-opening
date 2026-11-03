import { expect, it, vi } from "vitest";
import type { TurnInput } from "@aistudy/contracts";
import { submitFailedTurnRetry } from "./turn-wait";

const conversationId = "11111111-1111-4111-8111-111111111111";
const assistantTurnId = "22222222-2222-4222-8222-222222222222";
const sourceA = "33333333-3333-4333-8333-333333333333";
const sourceB = "44444444-4444-4444-8444-444444444444";

it("submits only the original failed-turn handle instead of adopting the current B selection", async () => {
  const submit = vi.fn<(input: TurnInput) => Promise<string>>().mockResolvedValue("accepted");
  const currentSelection = { sourceIds: [sourceB], currentPage: 8 };
  const original = { assistantTurnId, text: "原问题 A", mode: "hint" as const, clientKey: `retry-${assistantTurnId}` };
  await expect(submitFailedTurnRetry(conversationId, original, submit)).resolves.toBe("accepted");
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    conversationId, text: "原问题 A", mode: "hint", privacy: "saved", sourceIds: [], clientKey: `retry-${assistantTurnId}`,
  });
  expect(currentSelection).toEqual({ sourceIds: [sourceB], currentPage: 8 });
  expect(submit.mock.calls[0]?.[0]).not.toHaveProperty("currentPage");
  expect(submit.mock.calls[0]?.[0].sourceIds).not.toContain(sourceB);
  expect(submit.mock.calls[0]?.[0].sourceIds).not.toContain(sourceA); // Resolved from the owned persisted turn, never guessed locally.
});

it("leaves an explicit new B question as a separate request and key", async () => {
  const submit = vi.fn<(input: TurnInput) => Promise<string>>().mockResolvedValue("accepted");
  const original = { assistantTurnId, text: "原问题 A", mode: "hint" as const, clientKey: `retry-${assistantTurnId}` };
  await submitFailedTurnRetry(conversationId, original, submit);
  const edited: TurnInput = { conversationId, text: "针对 B 的新问题", privacy: "saved", sourceIds: [sourceB], sourceSelection: "selected", clientKey: "independent-new-intent" };
  await submit(edited);
  expect(submit.mock.calls[1]?.[0]).toEqual(edited);
  expect(submit.mock.calls[1]?.[0].clientKey).not.toBe(original.clientKey);
});
