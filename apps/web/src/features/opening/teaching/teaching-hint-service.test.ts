import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
const read = vi.hoisted(() => vi.fn());
vi.mock("@aistudy/database", () => ({ createOpeningTeachingHintRepository: () => ({ read }) }));
import { createTeachingHintService } from "./teaching-hint-service";
const id = "11111111-1111-4111-8111-111111111111", scope = { workspaceId: id, ownerUserId: id };
describe("teaching hint request boundary", () => {
  it("passes explicit attempt and stage to the owned repository", () => {
    createTeachingHintService({} as Sql).read(scope, { attemptId: id, level: 3 });
    expect(read).toHaveBeenCalledWith(scope, { attemptId: id, level: 3 });
  });
  it("rejects invented stages or client-defined qualifications before access", () => {
    read.mockClear();
    for (const input of [{ attemptId: id, level: 5 }, { attemptId: id, level: 1, supportDomain: "language" }]) {
      expect(() => createTeachingHintService({} as Sql).read(scope, input)).toThrow();
    }
    expect(read).not.toHaveBeenCalled();
  });
});
