import type { TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { assertIdentitySessionForWriteInTx, type ServerSessionWriteCredential } from "./identity";

const credential: ServerSessionWriteCredential = {
  userId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  tokenHash: "synthetic-hash", jwtExpiresAtSeconds: 2000000000,
};
function fakeTx(results: unknown[][]) {
  const query = vi.fn();
  for (const rows of results) query.mockResolvedValueOnce(rows);
  return { query, tx: query as unknown as TransactionSql };
}
const isolation = [{ transaction_isolation: "read committed" }];
const row = [{ id: credential.sessionId }];

describe("assertIdentitySessionForWriteInTx", () => {
  it("returns void, executes every check again on a final-only/repeated call", async () => {
    const { tx, query } = fakeTx([isolation, row, row, row, row, isolation, row, row, row, []]);
    await expect(assertIdentitySessionForWriteInTx(tx, credential)).resolves.toBeUndefined();
    await expect(assertIdentitySessionForWriteInTx(tx, credential)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(query).toHaveBeenCalledTimes(10);
  });

  it.each(["repeatable read", "serializable", "read uncommitted"])("fails closed for %s", async (level) => {
    const { tx, query } = fakeTx([[{ transaction_isolation: level }]]);
    await expect(assertIdentitySessionForWriteInTx(tx, credential)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 3, 4])("rejects missing/invalid DB state at step %s", async (step) => {
    const rows = [isolation, row, row, row, row];
    rows[step] = [];
    const { tx, query } = fakeTx(rows);
    await expect(assertIdentitySessionForWriteInTx(tx, credential)).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Invalid write session" });
    expect(query).toHaveBeenCalledTimes(step + 1);
  });

  it.each(["55P03", "40P01", "40001", "08006"])("propagates native %s unchanged without retry", async (code) => {
    const { tx, query } = fakeTx([isolation, row]);
    const error = Object.assign(new Error("synthetic native failure"), { code });
    query.mockRejectedValueOnce(error);
    await expect(assertIdentitySessionForWriteInTx(tx, credential)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each([NaN, Infinity, -Infinity])("does not send nonfinite exp %s to PG", async (exp) => {
    const { tx, query } = fakeTx([isolation, row, row, row]);
    await expect(assertIdentitySessionForWriteInTx(tx, { ...credential, jwtExpiresAtSeconds: exp })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(query).toHaveBeenCalledTimes(4);
  });
});
