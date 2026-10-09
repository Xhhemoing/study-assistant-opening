import { describe, expect, it } from "vitest";
import { nodeIdForSkillLabel } from "./knowledge-node-lookup";

const NODE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

describe("nodeIdForSkillLabel", () => {
  it("returns the matching node id for an exact skill label", () => {
    expect(
      nodeIdForSkillLabel(
        {
          nodes: [
            { id: NODE, label: "chain rule" },
            { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", label: "limits" },
          ],
        },
        "chain rule",
      ),
    ).toBe(NODE);
  });

  it("returns null when knowledge is missing or the label does not match", () => {
    expect(nodeIdForSkillLabel(null, "chain rule")).toBeNull();
    expect(nodeIdForSkillLabel({ nodes: [] }, "chain rule")).toBeNull();
    expect(
      nodeIdForSkillLabel({ nodes: [{ id: NODE, label: "limits" }] }, "chain rule"),
    ).toBeNull();
    expect(nodeIdForSkillLabel({ nodes: [{ id: NODE, label: "chain rule" }] }, "  ")).toBeNull();
  });
});
