import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { middleware } from "../../../../../../middleware";
import { POST } from "./route";
import { decryptDingTalkCallbackPlaintext } from "../../../../../../../../worker/src/connectors/dingtalk-client";

const path = "/api/opening/connections/dingtalk/events";
const base = "https://study.example";
const sql = vi.hoisted(() => vi.fn());
vi.mock("../../../../../../server/runtime", () => ({ getAuthRuntime: () => ({ sql }) }));

describe("DingTalk webhook ingress", () => {
  beforeEach(() => {
    sql.mockClear();
    vi.stubEnv("PUBLIC_BASE_URL", base);
    vi.stubEnv("OPENING_DINGTALK_CALLBACK_TOKEN", "fixture-token");
    vi.stubEnv("OPENING_DINGTALK_ENCODING_AES_KEY", "A".repeat(43));
    vi.stubEnv("OPENING_DINGTALK_CORP_ID", "fixture-corp");
  });
  afterEach(() => vi.unstubAllEnvs());

  function webhook(body: BodyInit, input: { signature?: string; timestamp?: string; msgSignature?: string; timeStamp?: string } = {}, headers?: HeadersInit) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = input.msgSignature ?? input.signature ?? "forged";
    const timeStamp = input.timeStamp ?? input.timestamp ?? String(timestamp);
    return new NextRequest(`${base}${path}?msg_signature=${signature}&timeStamp=${timeStamp}&nonce=fixture`, {
      method: "POST", body, headers, duplex: "half",
    });
  }

  function encryptedEnvelope(plaintext: string) {
    const encodingAesKey = "A".repeat(43);
    const key = Buffer.from(`${encodingAesKey}=`, "base64");
    const message = Buffer.from(plaintext, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(message.byteLength);
    const plain = Buffer.concat([randomBytes(16), length, message, Buffer.from("fixture-corp", "ascii")]);
    const padding = 32 - (plain.byteLength % 32);
    const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    const encrypt = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const msgSignature = createHash("sha1").update(["fixture-token", timestamp, "fixture", encrypt].sort().join("")).digest("hex");
    return { body: JSON.stringify({ encrypt }), request: webhook(JSON.stringify({ encrypt }), { msgSignature, timeStamp: timestamp }), encrypt, timestamp };
  }

  it("passes an originless webhook to signature verification and strips cookies", async () => {
    const request = webhook(JSON.stringify({ encrypt: "encrypted" }), {}, { cookie: "aistudy_session=fixture" });
    const next = middleware(request);
    expect(next.headers.get("x-middleware-next")).toBe("1");
    expect(next.headers.get("x-middleware-override-headers")?.split(",")).not.toContain("cookie");
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "SIGNATURE" } });
    expect(sql).not.toHaveBeenCalled();
  });

  it("accepts a signed provider check_url envelope and returns its encrypted acknowledgement", async () => {
    const input = encryptedEnvelope(JSON.stringify({ EventType: "check_url" }));
    const request = new NextRequest(input.request.url, { method: "POST", body: input.body, duplex: "half" });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const ack = await response.json() as { msg_signature: string; timeStamp: string; nonce: string; encrypt: string };
    expect(ack).toMatchObject({ timeStamp: input.timestamp, nonce: "fixture" });
    expect(decryptDingTalkCallbackPlaintext({ encodingAesKey: "A".repeat(43), corpIdOrKey: "fixture-corp", encrypt: ack.encrypt })).toBe("success");
  });

  it.each([
    ["POST", "/api/opening/connections/imap"], ["POST", `${path}/`],
    ["POST", `${path}/extra`], ["PATCH", path],
  ])("still requires Origin for %s %s", (method, pathname) => {
    expect(middleware(new NextRequest(`${base}${pathname}`, { method })).status).toBe(403);
  });

  it("cancels a multi-chunk webhook above the byte limit before signature verification", async () => {
    const cancel = vi.fn();
    const chunk = new TextEncoder().encode("中".repeat(12_000));
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++chunks <= 4) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });
    const response = await POST(webhook(stream));
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(sql).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized body even when signing parameters are absent", async () => {
    const request = new Request(`${base}${path}`, { method: "POST", headers: { "content-length": "65537" } });
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sql).not.toHaveBeenCalled();
  });
});
