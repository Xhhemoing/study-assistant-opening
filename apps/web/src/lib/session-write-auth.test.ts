import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSessionToken } from "@aistudy/database";
import { createSessionJwt, readSessionWriteCredential } from "./session";

const secret = "synthetic-session-write-auth-secret";
const claims = { sub: randomUUID(), workspaceId: randomUUID(), sid: randomUUID() };
// Raw signing allows malformed external claims (SignJWT rejects some at signing).
function sign(payload: Record<string, unknown>, key = secret) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${header}.${body}`;
  return `${data}.${createHmac("sha256", key).update(data).digest("base64url")}`;
}

describe("readSessionWriteCredential", () => {
  it("retains signed scope, exact token hash and JWT exp without consulting DB", async () => {
    const token = await createSessionJwt(claims, secret, 300);
    const exp = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).exp;
    expect(await readSessionWriteCredential(token, secret)).toEqual({
      userId: claims.sub, workspaceId: claims.workspaceId, sessionId: claims.sid,
      tokenHash: hashSessionToken(token), jwtExpiresAtSeconds: exp,
    });
  });

  it.each([undefined, null, "", "not-a-jwt"])("rejects absent/malformed token %s", async (token) => {
    expect(await readSessionWriteCredential(token, secret)).toBeNull();
  });

  it("rejects bad signatures and expired tokens", async () => {
    expect(await readSessionWriteCredential(sign({ ...claims, exp: Date.now() / 1000 + 60 }, "wrong"), secret)).toBeNull();
    expect(await readSessionWriteCredential(sign({ ...claims, exp: Date.now() / 1000 - 1 }), secret)).toBeNull();
  });

  it.each([undefined, null, "123", "Infinity", 0, -1])("requires a finite, unexpired numeric exp (%s)", async (exp) => {
    expect(await readSessionWriteCredential(sign({ ...claims, exp }), secret)).toBeNull();
  });

  it.each(["sub", "workspaceId", "sid"])("validates UUID boundary %s", async (field) => {
    for (const value of [undefined, 12, "", "not-a-uuid"]) {
      expect(await readSessionWriteCredential(sign({ ...claims, [field]: value, exp: Date.now() / 1000 + 60 }), secret)).toBeNull();
    }
  });

  it("hashes the full signed token, not just the session id", async () => {
    const exp = Date.now() / 1000 + 60;
    const a = await readSessionWriteCredential(sign({ ...claims, exp, jti: "a" }), secret);
    const b = await readSessionWriteCredential(sign({ ...claims, exp, jti: "b" }), secret);
    expect(a?.sessionId).toBe(b?.sessionId);
    expect(a?.tokenHash).not.toBe(b?.tokenHash);
  });
});
