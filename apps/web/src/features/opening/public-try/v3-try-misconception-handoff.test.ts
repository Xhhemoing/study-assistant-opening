import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  issueTryMisconceptionReceipt,
  verifyTryMisconceptionReceipt,
} from "./v3-try-misconception-handoff";

const secret = "synthetic-signing-secret-with-32-characters";
const selection = { challenge: "limit", step: 0, reason: 0 };
const stamp = { nowMs: Date.UTC(2026, 10, 21), issueSeq: 1 };

it("issues a bounded signed receipt with only the server's candidate signal", () => {
  const token = issueTryMisconceptionReceipt(selection, secret, stamp);
  const claim = verifyTryMisconceptionReceipt(token!, secret);
  expect(claim).toMatchObject({ conceptKey: "limit", issuedAt: stamp.nowMs, issueSeq: 1, expiresAt: stamp.nowMs + 900_000 });
  expect(claim.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
  const encoded = token!.split(".")[0]!;
  expect(Object.keys(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).sort()).toEqual([
    "conceptKey", "expiresAt", "issueSeq", "issuedAt", "misconceptionCode", "receiptId", "summary",
  ]);
  expect(issueTryMisconceptionReceipt({ ...selection, step: 2 }, secret, stamp)).toBeNull();
});

it.each([undefined, 0])("rejects signed receipts with issue sequence %s", issueSeq => {
  const [body] = issueTryMisconceptionReceipt(selection, secret, stamp)!.split(".");
  const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
  payload.issueSeq = issueSeq;
  const legacy = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`opening:try-misconception:v2.${legacy}`).digest("base64url");
  expect(() => verifyTryMisconceptionReceipt(`${legacy}.${signature}`, secret)).toThrow();
});

it("rejects a process-local sequence signed under the previous receipt protocol", () => {
  const [body] = issueTryMisconceptionReceipt(selection, secret, stamp)!.split(".");
  const signature = createHmac("sha256", secret).update(`opening:try-misconception:v1.${body}`).digest("base64url");
  expect(() => verifyTryMisconceptionReceipt(`${body}.${signature}`, secret)).toThrow();
});

it("rejects tampering, unsafe selection fields and even signed unexpected fields", () => {
  const token = issueTryMisconceptionReceipt(selection, secret, stamp)!;
  const [body, signature] = token.split(".");
  expect(() => verifyTryMisconceptionReceipt(`${body}.${signature!.replace(/^./, signature![0] === "A" ? "B" : "A")}`, secret)).toThrow();
  expect(() => issueTryMisconceptionReceipt({ ...selection, answerKey: "private" }, secret, stamp)).toThrow();
  expect(() => issueTryMisconceptionReceipt({ ...selection, step: 8 }, secret, stamp)).toThrow();

  const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
  const unsafe = Buffer.from(JSON.stringify({ ...payload, sealedSolution: "private" })).toString("base64url");
  const validSignature = createHmac("sha256", secret).update(`opening:try-misconception:v2.${unsafe}`).digest("base64url");
  expect(() => verifyTryMisconceptionReceipt(`${unsafe}.${validSignature}`, secret)).toThrow();
});

it("fails closed if the signing secret is unavailable", () => {
  vi.stubEnv("AUTH_SECRET", undefined);
  try {
    expect(() => issueTryMisconceptionReceipt(selection, process.env.AUTH_SECRET, stamp)).toThrow();
    expect(() => verifyTryMisconceptionReceipt("anything", "short")).toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});
