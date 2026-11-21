import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type DingTalkCallbackConfig = {
  token: string;
  encodingAesKey: string;
  corpIdOrKey: string;
};

export type DingTalkEncryptedCallback = {
  msg_signature: string;
  timeStamp: string;
  nonce: string;
  encrypt: string;
};

export type DingTalkCallbackEnvelope = {
  msg_signature?: string;
  signature?: string;
  timeStamp?: string;
  timestamp?: string;
  nonce?: string;
  encrypt?: string;
  encryptedBody?: string;
};

export class DingTalkClientError extends Error {
  constructor(
    readonly code:
      | "INVALID_CONFIG"
      | "SIGNATURE"
      | "PAYLOAD"
      | "CORP_ID"
      | "FORMAT",
    message: string,
  ) {
    super(message);
    this.name = "DingTalkClientError";
  }
}

function sortedSignature(token: string, timestamp: string, nonce: string, encrypted: string) {
  return createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
}

function safeEquals(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function callbackParts(input: DingTalkCallbackEnvelope) {
  return {
    signature: input.msg_signature ?? input.signature ?? "",
    timestamp: input.timeStamp ?? input.timestamp ?? "",
    nonce: input.nonce ?? "",
    encryptedBody: input.encrypt ?? input.encryptedBody ?? "",
  };
}

function aesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32 || encodingAesKey.length !== 43 || !/^[a-zA-Z0-9]+$/.test(encodingAesKey)) {
    throw new DingTalkClientError("INVALID_CONFIG", "encoding AES key is invalid");
  }
  return key;
}

function decryptPayload(input: {
  encodingAesKey: string;
  corpIdOrKey: string;
  encryptedBody: string;
}): string {
  const key = aesKey(input.encodingAesKey);
  const encrypted = Buffer.from(input.encryptedBody, "base64");
  if (encrypted.length === 0 || encrypted.length % 16 !== 0) {
    throw new DingTalkClientError("PAYLOAD", "encrypted payload is invalid");
  }
  let padded: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new DingTalkClientError("PAYLOAD", "encrypted payload cannot be decrypted");
  }
  if (padded.length < 37) {
    throw new DingTalkClientError("PAYLOAD", "decrypted payload is too short");
  }
  const messageLength = padded.subarray(16, 20).readUInt32BE();
  const messageEnd = 20 + messageLength;
  const paddingLength = padded[padded.length - 1]!;
  if (
    messageLength === 0
    || messageEnd >= padded.length
    || paddingLength < 1
    || paddingLength > 32
    || !padded.subarray(messageEnd).some(byte => byte === paddingLength)
  ) {
    throw new DingTalkClientError("CORP_ID", "decrypted payload padding is invalid");
  }
  const corpId = padded.subarray(messageEnd, padded.length - paddingLength).toString("ascii");
  if (!safeEquals(corpId, input.corpIdOrKey)) {
    throw new DingTalkClientError("CORP_ID", "decrypted payload belongs to another organization");
  }
  return padded.subarray(20, messageEnd).toString("utf8");
}

function encryptPayload(input: {
  encodingAesKey: string;
  corpIdOrKey: string;
  message: string;
}) {
  const key = aesKey(input.encodingAesKey);
  const random = randomBytes(16);
  const message = Buffer.from(input.message, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.byteLength);
  const plain = Buffer.concat([
    random,
    length,
    message,
    Buffer.from(input.corpIdOrKey, "ascii"),
  ]);
  const padding = 32 - (plain.byteLength % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

/**
 * Verify before parsing/trusting event content, then decrypt and bind the
 * payload to the configured enterprise identity.
 */
export function verifyAndDecryptDingTalkEvent(input: DingTalkCallbackConfig & DingTalkCallbackEnvelope): unknown {
  const callback = callbackParts(input);
  if (!input.token || !callback.nonce || !/^\d+$/.test(callback.timestamp)) {
    throw new DingTalkClientError("FORMAT", "callback request is incomplete");
  }
  const expectedSignature = sortedSignature(
    input.token,
    callback.timestamp,
    callback.nonce,
    callback.encryptedBody,
  );
  if (!safeEquals(callback.signature, expectedSignature)) {
    throw new DingTalkClientError("SIGNATURE", "callback signature is invalid");
  }
  const plaintext = decryptPayload({
    encodingAesKey: input.encodingAesKey,
    corpIdOrKey: input.corpIdOrKey,
    encryptedBody: callback.encryptedBody,
  });
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    // DingTalk's URL verification payload is a signed encrypted string. Event
    // delivery remains JSON, while the check_url path only needs verification
    // and a compliant encrypted acknowledgement.
    return plaintext;
  }
}

/** Verify and decrypt without assuming the protocol string is JSON. */
export function decryptDingTalkCallbackPlaintext(input: {
  encodingAesKey: string;
  corpIdOrKey: string;
  encryptedBody?: string;
  encrypt?: string;
}): string {
  return decryptPayload({ ...input, encryptedBody: input.encrypt ?? input.encryptedBody ?? "" });
}

/** Encrypt DingTalk's required success acknowledgement; never return plaintext. */
export function buildDingTalkCallbackResponse(input: DingTalkCallbackConfig & {
  timestamp: string;
  nonce: string;
}): DingTalkEncryptedCallback {
  const encrypted = encryptPayload({
    encodingAesKey: input.encodingAesKey,
    corpIdOrKey: input.corpIdOrKey,
    message: "success",
  });
  return {
    msg_signature: sortedSignature(input.token, input.timestamp, input.nonce, encrypted),
    timeStamp: input.timestamp,
    nonce: input.nonce,
    encrypt: encrypted,
  };
}

/** Callback timestamps outside this window are rejected even if signed. */
export function isFreshDingTalkEventTimestamp(
  timestamp: string,
  maxAgeSeconds = 300,
  now: () => number = Date.now,
): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  return Math.abs(now() - seconds * 1000) <= maxAgeSeconds * 1000;
}

/**
 * Local process store for the current callback slice. A durable database
 * ledger must replace it before callbacks are exposed across worker restarts.
 */
export function createDingTalkEventReplayStore() {
  const seen = new Set<string>();
  return {
    seen(workspaceId: string, eventId: string): boolean {
      const key = JSON.stringify([workspaceId, eventId]);
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    },
  };
}


