import { expect, it } from "vitest";
import { sourceMimeSchema } from "./sources";

it("accepts text/plain and rejects unknown MIME (S9)", () => {
  expect(sourceMimeSchema.parse("text/plain")).toBe("text/plain");
  expect(sourceMimeSchema.safeParse("application/x-unknown").success).toBe(false);
  expect(sourceMimeSchema.safeParse("text/markdown").success).toBe(true);
});
