import { expect, it } from "vitest";
import { explicitRegradeConfirmSchema, explicitRegradePrepareSchema } from "./explicit-regrade";
const id = "b39b974a-9b3c-4781-a740-f1b8ccf15a0c";

it("accepts only explicit, versioned double-charge consent", () => {
  const input = { requestId: id, confirmationVersion: "double-charge-v1", acceptPossibleDoubleCharge: true };
  expect(explicitRegradeConfirmSchema.parse(input)).toEqual(input);
  for (const patch of [{ acceptPossibleDoubleCharge: false }, { acceptPossibleDoubleCharge: undefined },
    { confirmationVersion: "old" }, { operationId: "ai-grade:anything" }]) {
    expect(explicitRegradeConfirmSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  }
});

it("rejects arbitrary paid identity, photo overrides and missing predecessor versions", () => {
  const input = { observationId: id, expectedHead: id, expectedGradingVersion: 0, clientKey: "tab-1" };
  expect(explicitRegradePrepareSchema.parse(input)).toEqual(input);
  for (const patch of [{ expectedHead: undefined }, { expectedGradingVersion: undefined }, { expectedGradingVersion: -1 },
    { clientKey: " " }, { operationId: "ai-regrade:random" }, { workSourceId: id }]) {
    expect(explicitRegradePrepareSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  }
});
