import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDingTalkCallbackResponse,
  createDingTalkEventReplayStore,
  decryptDingTalkCallbackPlaintext,
  DingTalkClientError,
  isFreshDingTalkEventTimestamp,
  verifyAndDecryptDingTalkEvent,
} from "./dingtalk-client";

const token = "opening";
const key43 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const aesKey = Buffer.from(key43 + "=", "base64");
const corpId = "ding1234567890";

function encryptCallback(plaintext: string, key: Buffer, id: string) {
  const random = randomBytes(16);
  const message = Buffer.from(plaintext, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.byteLength);
  const plain = Buffer.concat([random, length, message, Buffer.from(id, "ascii")]);
  const padding = 32 - (plain.byteLength % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-256-cbc", key, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function signatureFor(tokenValue: string, timestamp: string, nonce: string, encrypted: string) {
  return createHash("sha1")
    .update([tokenValue, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
}

describe("dingtalk callback client", () => {
  it("decrypts a signed event and validates the corp id", () => {
    const timestamp = "1760000000";
    const nonce = "nonce";
    const encrypted = encryptCallback('{"eventId":"event-1"}', aesKey, corpId);
    const event = verifyAndDecryptDingTalkEvent({
      token, encodingAesKey: key43, corpIdOrKey: corpId,
      signature: signatureFor(token, timestamp, nonce, encrypted),
      timestamp, nonce, encryptedBody: encrypted,
    });
    expect(event).toEqual({ eventId: "event-1" });
  });

  it("rejects forged signatures before trusting event content", () => {
    const timestamp = "1760000000";
    const nonce = "nonce";
    const encrypted = encryptCallback('{"eventId":"forged"}', aesKey, corpId);
    expect(() => verifyAndDecryptDingTalkEvent({
      token, encodingAesKey: key43, corpIdOrKey: corpId,
      signature: signatureFor("other-token", timestamp, nonce, encrypted),
      timestamp, nonce, encryptedBody: encrypted,
    })).toThrow(DingTalkClientError);
  });

  it("rejects a decrypted payload belonging to another organization", () => {
    const timestamp = "1760000000";
    const nonce = "nonce";
    const encrypted = encryptCallback('{"eventId":"cross-org"}', aesKey, "other-corp");
    expect(() => verifyAndDecryptDingTalkEvent({
      token, encodingAesKey: key43, corpIdOrKey: corpId,
      signature: signatureFor(token, timestamp, nonce, encrypted),
      timestamp, nonce, encryptedBody: encrypted,
    })).toThrow(DingTalkClientError);
  });

  it("rejects stale callbacks using the injected clock", () => {
    expect(isFreshDingTalkEventTimestamp("60", 300, () => 60_000 + 301_000)).toBe(false);
    expect(isFreshDingTalkEventTimestamp("60", 300, () => 60_000 + 299_000)).toBe(true);
  });

  it("returns a signed encrypted success response", () => {
    const timestamp = "1760000000";
    const nonce = "nonce";
    const response = buildDingTalkCallbackResponse({ token, encodingAesKey: key43, corpIdOrKey: corpId, timestamp, nonce });
    const decrypted = decryptDingTalkCallbackPlaintext({
      encodingAesKey: key43, corpIdOrKey: corpId, encryptedBody: response.encrypted,
    });
    expect(decrypted).toBe("success");
    expect(response.signature).toBe(signatureFor(token, timestamp, nonce, response.encrypted));
  });

  it("tracks replayed event keys idempotently", () => {
    const store = createDingTalkEventReplayStore();
    expect(store.seen("connection-1", "event-1")).toBe(false);
    expect(store.seen("connection-1", "event-1")).toBe(true);
    expect(store.seen("connection-2", "event-1")).toBe(false);
  });
});
