import { randomBytes, scrypt as scryptCb } from "node:crypto";
import postgres from "postgres";

/**
 * E2E owner seeding for opening mode: public registration is disabled there,
 * so tests provision the owner account surgically (this user only) and log in
 * through the real /api/auth/login route.
 */
const E2E_EMAIL = "opening-e2e-owner@example.com";
const E2E_PASSWORD = "opening-e2e-password";

const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

function scryptAsync(
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      password,
      salt,
      KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (err: Error | null, derivedKey: Buffer) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function seedOpeningOwner(): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is required to seed the opening owner");
  const sql = postgres(url);
  try {
    await sql`DELETE FROM users WHERE email = ${E2E_EMAIL}`;
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (
        gen_random_uuid(),
        ${E2E_EMAIL},
        'Opening E2E Owner',
        ${await hashPassword(E2E_PASSWORD)}
      )
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id)
      VALUES (gen_random_uuid(), (SELECT id FROM users WHERE email = ${E2E_EMAIL}))
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function loginOpeningOwner(
  request: {
    post: (
      url: string,
      options: { data: unknown; headers?: Record<string, string> },
    ) => Promise<{ status(): number }>;
  },
  baseUrl: string,
): Promise<void> {
  // Playwright's API request context does not send Origin automatically;
  // the F01 CSRF middleware requires it for cookie-auth mutations.
  const response = await request.post("/api/auth/login", {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
    headers: { origin: baseUrl },
  });
  if (response.status() !== 200) {
    throw new Error(`opening owner login failed: ${response.status()}`);
  }
}

export function isOpeningReleaseEnabled(): boolean {
  const raw = process.env.OPENING_RELEASE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
