import { expect, it } from "vitest";
import { parseTryContinuation } from "./continuation";

const valid = { from: "try", challenge: "matrix", step: "3" };

it("selects only a registered question and one of its own steps", () => {
  expect(parseTryContinuation(valid)).toEqual({ challenge: "matrix", step: 3 });
  expect(parseTryContinuation({ ...valid, step: "0" })).toEqual({ challenge: "matrix", step: 0 });
});

it.each([
  { from: "other" }, { from: ["try", "try"] }, { challenge: "unknown" },
  { challenge: "https://outside.example" }, { challenge: "//outside.example" },
  { challenge: ["matrix"] }, { step: ["0", "1"] }, { step: "4" }, { step: "-1" },
  { step: "" }, { step: "1.0" }, { step: "01" }, { step: "1e0" }, { step: undefined },
])("rejects a malformed continuation %j", invalid => {
  expect(parseTryContinuation({ ...valid, ...invalid })).toBeNull();
});
