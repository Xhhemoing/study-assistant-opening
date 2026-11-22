import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  issueTryMisconceptionReceipt,
  verifyTryMisconceptionReceipt,
} from "./v3-try-misconception-handoff";

const secret = "synthetic-signing-secret-with-32-characters";
const selection = { challenge: "limit", step: 0, reason: 0 };

it("issues a bounded signed receipt with only the server's candidate signal", () => {
  const now = Date.UTC(2026, 10, 21);
  const token = issueTryMisconceptionReceipt(selection, secret, now);
  const claim = verifyTryMisconceptionReceipt(token!, secret);
  expect(claim).toMatchObject({ conceptKey: "limit", expiresAt: now + 900_000 });
  expect(claim.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
  const encoded = token!.split(".")[0]!;
  expect(Object.keys(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).sort()).toEqual([
    "conceptKey", "expiresAt", "issuedAt", "misconceptionCode", "receiptId", "summary",
  ]);
  expect(issueTryMisconceptionReceipt({ ...selection, step: 2 }, secret, now)).toBeNull();
});

it("rejects tampering, unsafe selection fields and even signed unexpected fields", () => {
  const token = issueTryMisconceptionReceipt(selection, secret)!;
  const [body, signature] = token.split(".");
  expect(() => verifyTryMisconceptionReceipt(`${body}.${signature!.replace(/^./, signature![0] === "A" ? "B" : "A")}`, secret)).toThrow();
  expect(() => issueTryMisconceptionReceipt({ ...selection, answerKey: "private" }, secret)).toThrow();
  expect(() => issueTryMisconceptionReceipt({ ...selection, step: 8 }, secret)).toThrow();

  const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
  const unsafe = Buffer.from(JSON.stringify({ ...payload, sealedSolution: "private" })).toString("base64url");
  const validSignature = createHmac("sha256", secret).update(`opening:try-misconception:v1.${unsafe}`).digest("base64url");
  expect(() => verifyTryMisconceptionReceipt(`${unsafe}.${validSignature}`, secret)).toThrow();
});

it("fails closed if the signing secret is unavailable", () => {
  vi.stubEnv("AUTH_SECRET", undefined);
  try {
    expect(() => issueTryMisconceptionReceipt(selection)).toThrow();
    expect(() => verifyTryMisconceptionReceipt("anything", "short")).toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});
