#!/usr/bin/env tsx
/**
 * Create the first opening-release owner via protected stdin password only.
 * Refuses if any user already exists. Does not import the web auth service.
 */
import { createInterface } from "node:readline";
import { stdin as input, stdout as output, stderr } from "node:process";
import {
  createIdentityRepository,
  createSqlClient,
} from "../packages/database/src/index.ts";
import { hashPassword } from "../apps/web/src/lib/password.ts";

function usage(): never {
  console.error(
    "Usage: OPENING_OWNER_EMAIL=... OPENING_OWNER_DISPLAY_NAME=... tsx scripts/opening-create-owner.ts < password.txt",
  );
  console.error("Password is read from stdin only (never argv).");
  process.exit(2);
}

async function readPasswordFromStdin(): Promise<string> {
  if (input.isTTY) {
    // Interactive: do not echo. readline without mute is still better than argv;
    // prefer piped stdin in automation.
    stderr.write("Enter owner password (stdin): ");
  }
  const rl = createInterface({ input, output: input.isTTY ? undefined : output, terminal: false });
  let password = "";
  for await (const line of rl) {
    password = line;
    break;
  }
  rl.close();
  password = password.replace(/\r$/, "");
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters (from stdin)");
  }
  return password;
}

async function main(): Promise<void> {
  const email = process.env.OPENING_OWNER_EMAIL?.trim();
  const displayName = process.env.OPENING_OWNER_DISPLAY_NAME?.trim();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!email || !displayName || !databaseUrl) {
    usage();
  }

  // Refuse password via argv if someone passes it.
  if (process.argv.some((a) => a.startsWith("--password") || a === "-p")) {
    throw new Error("Password via argv is refused; use stdin only");
  }

  const password = await readPasswordFromStdin();
  const sql = createSqlClient(databaseUrl);
  try {
    const existing = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users
    `;
    const count = Number(existing[0]?.n ?? 0);
    if (count > 0) {
      throw new Error("Owner already exists; refusing to create another via CLI");
    }

    const passwordHash = await hashPassword(password);
    const identity = createIdentityRepository(sql);
    const created = await identity.createUserWithWorkspace({
      email,
      displayName,
      passwordHash,
    });
    console.log(
      JSON.stringify({
        status: "ok",
        userId: created.user.id,
        workspaceId: created.workspace.id,
        email: created.user.email,
      }),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
