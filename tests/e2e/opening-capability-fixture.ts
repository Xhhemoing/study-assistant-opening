import { randomBytes, randomUUID, scrypt as scryptCb } from "node:crypto";
import type { APIRequestContext, Cookie } from "@playwright/test";
import postgres from "postgres";

const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export type CapabilityAccount = {
  cookie: Cookie;
  connectionId: string;
  courseId: string;
  dispose(): Promise<void>;
};

/**
 * Isolated Paula capability account: real DB user + C01 unauthorized IMAP connection.
 * Cookie uses Playwright Cookie shape. Do NOT page.route-fake business APIs.
 */
export async function seedCapabilityAccount(request: APIRequestContext): Promise<CapabilityAccount> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is required for seedCapabilityAccount");

  const email = `u04-${randomUUID()}@example.com`;
  const password = `U04-${randomUUID()}-pass`;
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const sql = postgres(url, { max: 1, connect_timeout: 8 });

  try {
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${userId}, ${email}, 'Paula Capability', ${await hashPassword(password)})
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id)
      VALUES (${workspaceId}, ${userId})
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }

  const origin = process.env.PLAYWRIGHT_BASE_URL ?? process.env.OPENING_WEB_BASE_URL ?? "http://127.0.0.1:3000";
  const login = await request.post("/api/auth/login", {
    data: { email, password },
    headers: { origin },
  });
  if (login.status() !== 200) {
    throw new Error(`capability account login failed: ${login.status()}`);
  }

  const state = await request.storageState();
  const session = state.cookies.find((c) => c.name === "aistudy_session");
  if (!session) throw new Error("aistudy_session cookie missing after login");

  const cookie: Cookie = {
    name: session.name,
    value: session.value,
    domain: session.domain || "127.0.0.1",
    path: session.path || "/",
    expires: session.expires ?? -1,
    httpOnly: session.httpOnly ?? true,
    secure: session.secure ?? false,
    sameSite: (session.sameSite as Cookie["sameSite"]) ?? "Lax",
  };

  // C01: create unauthorized IMAP connection — no real school credentials.
  const since = new Date();
  since.setDate(since.getDate() - 14);
  const create = await request.post("/api/opening/connections/imap", {
    data: {
      label: "等待授权邮箱",
      host: process.env.OPENING_IMAP_E2E_HOST ?? "mail.example.edu",
      port: 993,
      tlsMode: "implicit",
      username: "unauthorized-student",
      folders: ["INBOX"],
      since: since.toISOString(),
      clientKey: `u04-imap-${randomUUID()}`,
    },
    headers: { origin, "content-type": "application/json" },
  });
  if (create.status() !== 201 && create.status() !== 200) {
    throw new Error(`create imap connection failed: ${create.status()} ${await create.text()}`);
  }
  const connection = (await create.json()) as { id: string; state?: string };
  if (!connection.id) throw new Error("connection id missing");

  const courseRes = await request.post("/api/courses", {
    data: {
      title: `U04 Course ${connection.id.slice(0, 8)}`,
      slug: `u04-${connection.id.slice(0, 8)}`,
      description: "capability fixture",
    },
    headers: { origin, "content-type": "application/json" },
  });
  if (!courseRes.ok()) {
    throw new Error(`create course failed: ${courseRes.status()} ${await courseRes.text()}`);
  }
  const courseBody = (await courseRes.json()) as { course?: { id: string }; id?: string };
  const courseId = courseBody.course?.id ?? courseBody.id;
  if (!courseId) throw new Error("course id missing");

  return {
    cookie,
    connectionId: connection.id,
    courseId,
    async dispose() {
      const cleanup = postgres(url, { max: 1, connect_timeout: 8 });
      try {
        await cleanup`DELETE FROM opening_connection_credentials WHERE connection_id = ${connection.id}`;
        await cleanup`DELETE FROM opening_connection_credential_requests WHERE connection_id = ${connection.id}`;
        await cleanup`DELETE FROM opening_connections WHERE id = ${connection.id}`;
        await cleanup`DELETE FROM course_asset_memberships WHERE course_id = ${courseId}`;
        await cleanup`DELETE FROM courses WHERE id = ${courseId}`;
        await cleanup`DELETE FROM sessions WHERE user_id = ${userId}`;
        await cleanup`DELETE FROM workspaces WHERE id = ${workspaceId}`;
        await cleanup`DELETE FROM users WHERE id = ${userId}`;
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
