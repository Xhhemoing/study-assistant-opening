import { expect, it } from "vitest";
import { assertCurrentEpoch } from "./privacy-guard";

it("rejects a worker built from deleted personal context", () => {
  expect(() => assertCurrentEpoch(2, 3)).toThrow();
  expect(() => assertCurrentEpoch(3, 3)).not.toThrow();
});
