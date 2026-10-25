import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const web = path.join(root, "apps/web");
const maxPdfBytes = 50 * 1024 * 1024;

// Real Next middleware cloning + real staging handler + real stream validator.
// Only identity/ticket persistence and the object-store sink are fixture adapters;
// no database, production account, object storage or model is contacted.
async function startFixture(legacy: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), "study-staging-http-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ private: true, type: "module" }),
    "next.config.mjs": `import deployed from ${JSON.stringify(path.join(web, "next.config.mjs"))};
export default { ...deployed, output: undefined, distDir: '.next', transpilePackages: [],
 experimental: { ...deployed.experimental, ${legacy ? "middlewareClientMaxBodySize: undefined," : ""} },
 webpack(config) { Object.assign(config.resolve.alias, ${JSON.stringify({
   [path.join(web, "src/features/opening/runtime")]: path.join(dir, "adapters.js"),
   [path.join(web, "src/features/opening/sources/source-service")]: path.join(dir, "adapters.js"),
   [path.join(web, "src/features/auth/service")]: path.join(dir, "adapters.js"),
   [path.join(web, "src/features/opening/server/data-services")]: path.join(dir, "adapters.js"),
   "@aistudy/database": path.join(root, "packages/database/src/storage/magic.ts"),
 })}); return config; }
};`,
    "middleware.js": `export { middleware } from ${JSON.stringify(path.join(web, "src/middleware.ts"))};`,
    "app/api/opening/sources/[id]/staging/route.js": `export { PUT } from ${JSON.stringify(path.join(web, "src/app/api/opening/sources/[id]/staging/route.ts"))};`,
    "adapters.js": `import { validatedUploadStream } from ${JSON.stringify(path.join(web, "src/features/opening/sources/upload-policy.ts"))};
import { uploadInputSchema } from ${JSON.stringify(path.join(root, "packages/contracts/src/opening/sources.ts"))};
let expected;
export async function requireOpeningScope(request) {
 if (request.headers.get('authorization') !== 'Bearer fixture') throw Object.assign(new Error('Authentication required'), { status: 401 });
 expected = uploadInputSchema.parse({ name: 'fixture.pdf', mime: 'application/pdf', bytes: Number(request.headers.get('x-fixture-bytes')), sha256: request.headers.get('x-fixture-sha256') });
 return { principal: {}, sql: {} };
}
export function createOpeningSourceService() { return {
 async getStagingPutTarget() { return expected; },
 async putStagingStream(_principal, _id, input) {
  const reader = validatedUploadStream(input.body, expected, input.signal).getReader();
  while (!(await reader.read()).done) { /* discard validated bytes, no external storage */ }
 }
}; }
export const isOpeningDataError = () => false;
export const mapDomainError = error => error;
export const jsonError = error => Response.json({ error: { message: error.message } }, { status: error.status ?? 400 });`,
  };
  let child: ChildProcess | undefined;
  let output = "";
  try {
    await symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const address = socket.address();
    if (!address || typeof address === "string") throw new Error("No isolated HTTP port");
    const port = address.port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", dir, "--hostname", "127.0.0.1", "--port", String(port)], {
      env: { ...process.env, NODE_ENV: "development", PUBLIC_BASE_URL: origin, NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=512" },
      stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Next readiness timeout: ${output}`)), 45000);
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("Ready in")) { clearTimeout(timeout); resolve(); }
      };
      child!.stdout!.on("data", collect);
      child!.stderr!.on("data", collect);
      child!.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Next exit ${code}: ${output}`)); });
    });
    return { origin, output: () => output, close: async () => {
      if (child?.pid) { process.kill(-child.pid, "SIGTERM"); await once(child, "exit"); }
      await rm(dir, { recursive: true, force: true });
    } };
  } catch (error) {
    if (child?.pid && child.exitCode === null) { process.kill(-child.pid, "SIGTERM"); await once(child, "exit"); }
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function pdf(bytes: number) {
  const body = Buffer.alloc(bytes, 32);
  body.write("%PDF-1.4\n");
  body.write("\n%%EOF\n", bytes - 7);
  return body;
}

async function upload(origin: string, body: Buffer, extra: Record<string, string> = {}, chunked = false) {
  const headers = {
    origin, authorization: "Bearer fixture", "content-type": "application/pdf",
    "x-fixture-bytes": String(body.length), "x-fixture-sha256": createHash("sha256").update(body).digest("hex"), ...extra,
  };
  return fetch(`${origin}/api/opening/sources/00000000-0000-4000-8000-0000000000aa/staging`, {
    method: "PUT", headers,
    body: chunked ? new ReadableStream({ start(controller) {
      for (let offset = 0; offset < body.length; offset += 64 * 1024) controller.enqueue(body.subarray(offset, offset + 64 * 1024));
      controller.close();
    } }) : body,
    ...(chunked ? { duplex: "half" } : {}),
  } as RequestInit);
}

describe("staging through real Next middleware HTTP", () => {
  it("reproduces default 10 MiB truncation, then preserves allowed PDFs and rejects unsafe/oversized uploads", async () => {
    const sample = pdf(11 * 1024 * 1024);
    const legacy = await startFixture(true);
    try {
      const response = await upload(legacy.origin, sample);
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(/stored bytes .* != expected/);
      expect(legacy.output()).toContain("Request body exceeded 10MB");
      console.info("legacy: 11MiB -> 400, actual Next 10MB truncation reproduced");
    } finally { await legacy.close(); }

    const fixed = await startFixture(false);
    try {
      for (const [size, chunked] of [[11 * 1024 * 1024, false], [11 * 1024 * 1024, true], [maxPdfBytes, false]] as const) {
        const response = await upload(fixed.origin, pdf(size), {}, chunked);
        expect(response.status, await response.text()).toBe(204);
        console.info(`fixed: ${size} bytes, chunked=${chunked} -> 204 (byte/hash/magic validated)`);
      }
      const tooLarge = await upload(fixed.origin, pdf(maxPdfBytes + 1));
      expect(tooLarge.status).toBe(400); // Existing begin/ticket schema refuses >50MiB.
      const ticketOverflow = await upload(fixed.origin, sample, { "x-fixture-bytes": String(sample.length - 1) });
      expect(ticketOverflow.status).toBe(413);
      const foreign = await upload(fixed.origin, sample, { origin: "https://foreign.example" });
      expect(foreign.status).toBe(403);
      const missingOrigin = await upload(fixed.origin, sample, { origin: "" });
      expect(missingOrigin.status).toBe(403);
      const anonymous = await upload(fixed.origin, sample, { authorization: "" });
      expect(anonymous.status).toBe(401);
      console.info("fixed: PDF >50MiB -> 400; ticket overflow -> 413; foreign/missing Origin -> 403; no fixture identity -> 401");
    } finally { await fixed.close(); }
  }, 180000);
});
