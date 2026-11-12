import { beforeEach, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import { generateOpeningStudyExposure, type OpeningStudyExposureInput } from "./opening-study-exposure";

const ports = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./opening-study-context", () => ({ resolveOpeningStudyContext: ports.resolve }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) }, itemVersionId = id(3), problemId = id(4), courseId = id(5);
const resolved = { purpose: "learning_help" as const, courseId, itemVersionId, attemptId: null };
const input: OpeningStudyExposureInput = { releaseKey: "d13-item-problem", contextAnchor: { purpose: "learning_help", itemVersionId },
  origin: "assistant", kind: "hint", level: "hinted" };
function fixture(itemFailure?: Error) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let inserted: Record<string, unknown> | null = null;
  const tx = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join("?").replace(/\s+/g, " ").trim(); queries.push({ text, values });
    if (text.startsWith("SELECT * FROM opening_help_exposures")) return [];
    if (text.startsWith("SELECT problem_id FROM opening_learning_item_versions")) {
      if (itemFailure) throw itemFailure;
      return [{ problem_id: problemId }];
    }
    if (text.startsWith("INSERT INTO opening_help_exposures")) {
      // Only this known INSERT: no SQL execution, filtering, transaction, or authorization model.
      const match = /^INSERT INTO opening_help_exposures\(([^)]+)\) VALUES\((.*)\) RETURNING \*$/.exec(text);
      if (!match) throw new Error("unrecognized exposure fixture insert");
      let binding = 0;
      inserted = Object.fromEntries(match[1]!.split(",").map((column, index) => [column.trim(),
        match[2]!.split(",")[index]!.trim() === "?" ? values[binding++] : null]));
      return [{ ...inserted, generated_at: "2026-01-01T00:00:00.000Z", released_at: null, acknowledged_at: null, history_revision: 0 }];
    }
    throw new Error(`unrecognized exposure fixture query: ${text}`);
  }), { json: (value: unknown) => value });
  return { tx: tx as unknown as TransactionSql, queries, inserted: () => inserted };
}
beforeEach(() => { vi.resetAllMocks(); ports.resolve.mockResolvedValue(resolved); });

it("binds the resolved item-only problem to the generated receipt without inventing an attempt", async () => {
  const f = fixture();
  const result = await generateOpeningStudyExposure(f.tx, scope, input);
  expect(f.queries).toHaveLength(3);
  expect(f.queries[0]!.text).toMatch(/^SELECT \* FROM opening_help_exposures/);
  expect(f.queries[2]!.text).toMatch(/^INSERT INTO opening_help_exposures/);
  expect(f.queries[1]).toEqual({ text: "SELECT problem_id FROM opening_learning_item_versions WHERE id=? AND workspace_id=? AND owner_user_id=?",
    values: [itemVersionId, scope.workspaceId, scope.ownerUserId] });
  expect(f.inserted()).toMatchObject({ item_version_id: itemVersionId, problem_id: problemId, attempt_id: null, course_id: courseId, context_anchor: resolved });
  expect(result).toMatchObject({ contextAnchor: resolved, releasedAt: null, acknowledgedAt: null, historyRevision: 0 });
});
it("propagates item-problem lookup failure by identity before any generated receipt insert", async () => {
  const failure = new Error("synthetic item-problem read failure"), f = fixture(failure);
  await expect(generateOpeningStudyExposure(f.tx, scope, input)).rejects.toBe(failure);
  expect(f.queries).toHaveLength(2); expect(f.inserted()).toBeNull();
});
