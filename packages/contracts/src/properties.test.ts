import { describe, expect, it } from "vitest";
import {
  documentPropertiesResponseSchema,
  readOnlyPropertySchema,
} from "./properties";

const property = {
  id: "11111111-1111-4111-8111-111111111111",
  key: "priority",
  valueType: "number" as const,
  value: 3,
  updatedAt: "2026-08-03T12:00:00.000Z",
};

describe("read-only property contracts", () => {
  it("parses document and block property groups without workspace internals", () => {
    expect(documentPropertiesResponseSchema.parse({
      document: [property],
      blocks: [{
        blockId: "22222222-2222-4222-8222-222222222222",
        blockType: "paragraph",
        text: "Evidence",
        properties: [{ ...property, key: "flagged", valueType: "boolean", value: true }],
      }],
    })).toEqual({
      document: [property],
      blocks: [{
        blockId: "22222222-2222-4222-8222-222222222222",
        blockType: "paragraph",
        text: "Evidence",
        properties: [{ ...property, key: "flagged", valueType: "boolean", value: true }],
      }],
    });
    expect(readOnlyPropertySchema.parse(property)).not.toHaveProperty("workspaceId");
  });

  it("requires a persisted value rather than accepting an omitted field", () => {
    const { value: _value, ...withoutValue } = property;
    expect(() => readOnlyPropertySchema.parse(withoutValue)).toThrow();
  });

  it("rejects unknown persisted property types and malformed ids", () => {
    expect(() => readOnlyPropertySchema.parse({ ...property, valueType: "date" })).toThrow();
    expect(() => documentPropertiesResponseSchema.parse({
      document: [],
      blocks: [{ blockId: "invalid", blockType: "paragraph", text: null, properties: [] }],
    })).toThrow();
  });
});
