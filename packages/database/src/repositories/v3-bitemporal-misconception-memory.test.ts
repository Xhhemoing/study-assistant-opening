import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { queryMisconceptionEdgesAsOf, readLearnerMisconceptionContextBlock, redeemTryMisconceptionHandoff, renderLearnerContextBlock } from "./v3-bitemporal-misconception-memory";

const scope = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const at = "2026-11-21 12:00:00.000001+00";
const claim = {
  receiptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", issuedAt: Date.UTC(2026, 10, 21, 11, 59),
  expiresAt: Date.UTC(2026, 10, 21, 12, 0, 1),
  payloadSha256: "a".repeat(64), conceptKey: "limit", misconceptionCode: "conditions", summary: "Review the conditions.",
};

function mockTransaction(...responses: unknown[][]) {
  const query = vi.fn();
  for (const rows of responses) {
    query.mockImplementationOnce(() => Object.assign(Promise.resolve(rows), {
      async *cursor() { if (rows.length) yield rows; },
    }));
  }
  const sql = { begin: (run: (tx: typeof query) => unknown) => run(query) } as unknown as Sql;
  return { sql, query };
}

it("replaces an unusable cached context using the same database timestamp for read and write", async () => {
  const empty = { renderedMarkdown: "", byteLength: 0, revision: 2 };
  const { sql, query } = mockTransaction([{ privacy_epoch: 0 }], [], [{ at }], [], [], [empty]);
  await expect(readLearnerMisconceptionContextBlock(sql, scope)).resolves.toEqual(empty);
  expect(query).toHaveBeenCalledTimes(6);
  for (const call of query.mock.calls.slice(3)) expect(call.slice(1)).toContain(at);
});

it.each(["ledger", "restored root"])("rejects replay from the %s when it does not match the locked privacy epoch", async path => {
  const privacyEpoch = 1;
  const stale = {
    edgeId: "77216238-c966-44b8-ab40-d9150e131e51", revisionId: "498ad0ef-8b34-45a8-872d-85bf108733dd", matches: false,
  };
  const { sql, query } = mockTransaction(
    [{ id: scope.workspaceId }], [], [{ revision: 0 }], [{ privacy_epoch: privacyEpoch }], [],
    [{ at, expired: false }], ...(path === "ledger" ? [[stale]] : [[], [stale]]),
  );
  await expect(redeemTryMisconceptionHandoff(sql, scope, claim)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(query).toHaveBeenCalledTimes(path === "ledger" ? 7 : 8);
  expect(query.mock.lastCall?.slice(1)).toContain(privacyEpoch);
  if (path === "restored root") expect(query.mock.lastCall?.slice(1)).toEqual(expect.arrayContaining([stale.edgeId, stale.revisionId]));
});

it("rejects first use before the restore cutoff without attempting an insert", async () => {
  const { sql, query } = mockTransaction(
    [{ id: scope.workspaceId }], [], [{ revision: 0 }], [{ privacy_epoch: 1 }], [],
    [{ at, expired: false }], [], [], [{ blocked: true }],
  );
  await expect(redeemTryMisconceptionHandoff(sql, scope, claim)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(query).toHaveBeenCalledTimes(9);
  expect(query.mock.lastCall?.slice(1)).toContain(claim.issuedAt);
});

it("preserves the database's masked predecessor in an as-of result", async () => {
  const query = vi.fn().mockResolvedValue([{ revisionId: scope.workspaceId, priorRevisionId: null }]);
  await expect(queryMisconceptionEdgesAsOf(query as unknown as Sql, scope, { validAt: at, txAt: at }))
    .resolves.toEqual([{ revisionId: scope.workspaceId, priorRevisionId: null }]);
});

it("denies a restored root with a different revision identity even when its scope and content match", async () => {
  const { sql, query } = mockTransaction(
    [{ id: scope.workspaceId }], [], [{ revision: 0 }], [{ privacy_epoch: 0 }], [],
    [{ at, expired: false }], [], [{ matches: true, revisionId: scope.workspaceId }],
  );
  await expect(redeemTryMisconceptionHandoff(sql, scope, claim)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(query).toHaveBeenCalledTimes(8);
});

it("rejects a competing revision insert without recording a receipt claim", async () => {
  const { sql, query } = mockTransaction(
    [{ id: scope.workspaceId }], [], [{ revision: 0 }], [{ privacy_epoch: 0 }], [],
    [{ at, expired: false }], [], [], [], [],
  );
  await expect(redeemTryMisconceptionHandoff(sql, scope, claim)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(query).toHaveBeenCalledTimes(10);
});

describe("LearnerContextBlock rendering", () => {
  it.each([" ", "\u3000", "\u0007"])("normalizes a long run of %j before applying the byte limit", whitespace => {
    const expected = "- 待确认：A B";
    expect(renderLearnerContextBlock([
      { status: "candidate", learnerDisposition: null, summary: "A" + whitespace.repeat(2047) + "B" },
    ])).toEqual({ renderedMarkdown: expected, byteLength: Buffer.byteLength(expected) });
  });

  it("fits multibyte text into the UTF-8 budget without truncating a code point", () => {
    const result = renderLearnerContextBlock([
      { status: "candidate", learnerDisposition: null, summary: "汉🧠".repeat(1000) },
    ]);
    expect(result.byteLength).toBe(Buffer.byteLength(result.renderedMarkdown));
    expect(result.byteLength).toBeGreaterThanOrEqual(2045);
    expect(result.byteLength).toBeLessThanOrEqual(2048);
    expect(result.renderedMarkdown).toMatch(/^- 待确认：(?:汉🧠)+汉?$/u);
  });

  it("renders source labels and keeps user Markdown on a single literal line", () => {
    expect(renderLearnerContextBlock([
      { status: "learner_reported", learnerDisposition: "disputed", summary: "原判断有误\n# <tag>" },
      { status: "verified", learnerDisposition: null, summary: "复核结果" },
    ]).renderedMarkdown).toBe("- 学习者提出异议：原判断有误 \\# \\<tag\\>\n- 已确认：复核结果");
  });
});
