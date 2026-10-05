import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { materialsInSpace, selectedMaterials } from "./material-spaces";
const base = (id: string, parseState: SourceRecord["parseState"] = "ready"): SourceRecord => ({ id, workspaceId: "11111111-1111-4111-8111-111111111111", name: `${id}.pdf`, mime: "application/pdf", bytes: 1, sha256: "ab".repeat(32), version: 0, uploadState: "uploaded", parseState, error: null, createdAt: "2026-10-03T00:00:00Z" });
const organization = { courses: [{ id: "course-a", title: "微积分", archived: false }], memberships: [{ courseId: "course-a", sourceId: "a", role: "core" }] };
describe("material spaces", () => {
  it("keeps the inbox as unassigned originals and course spaces as references", () => {
    const sources = [base("a"), base("b"), base("c", "failed")];
    expect(materialsInSpace(sources, organization, "inbox").map(item => item.id)).toEqual(["b", "c"]);
    expect(materialsInSpace(sources, organization, "course:course-a").map(item => item.id)).toEqual(["a"]);
    expect(materialsInSpace(sources, organization, "attention").map(item => item.id)).toEqual(["c"]);
  });
  it("drops selections that disappeared while a refresh was running", () => expect(selectedMaterials(["a", "missing", "a"], [base("a")])).toEqual(["a"]));
});
