import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";

/**
 * scrypt params chosen for Phase 1 self-host:
 * N=2^14 balances offline resistance with Node default memory limits.
 * Encoding: scrypt$N$r$p$saltB64url$hashB64url
 */
const N = 1 << 14;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      password,
      salt,
      keylen,
      options,
      (err: Error | null, derivedKey: Buffer) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  try {
    const actual = await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
