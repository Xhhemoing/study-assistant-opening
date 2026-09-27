import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpeningBackup } from "@aistudy/domain";
import { readOpeningBackupArchive, writeOpeningBackupArchive } from "./opening-backup-archive";
import { decryptOpeningArchive, encryptOpeningArchive } from "./opening-backup-cipher";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, link: vi.fn(actual.link), rm: vi.fn(actual.rm) };
});
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => "00000000-0000-4000-8000-000000000001",
    randomBytes: (size: number) => size === 8 ? Buffer.alloc(8) : actual.randomBytes(size) };
});
const actual = await vi.importActual<typeof fs>("node:fs/promises");
const roots: string[] = [];
const passphrase = "exclusive publication test";
const draft: OpeningBackup = {
  format: "opening-backup", version: 1, workspaceId: "a1000000-0000-4000-8000-000000000001",
  privacyEpoch: 0, deletionJournal: [], tables: {}, objects: [],
};
async function fixture(kind: "archive" | "encrypt" | "decrypt") {
  const root = await fs.mkdtemp(path.join(tmpdir(), "opening-publication-"));
  roots.push(root);
  const source = path.join(root, "source");
  const destination = path.join(root, "published");
  await fs.writeFile(source, "complete backup bytes", "utf8");
  if (kind === "decrypt") await encryptOpeningArchive(source, `${source}.enc`, passphrase);
  return {
    root, destination,
    run: () => kind === "archive" ? writeOpeningBackupArchive(draft, root, destination)
      : kind === "encrypt" ? encryptOpeningArchive(source, destination, passphrase)
        : decryptOpeningArchive(`${source}.enc`, destination, passphrase),
    verify: async () => {
      if (kind === "archive") {
        const reader = await readOpeningBackupArchive(destination);
        try { expect(reader.metadata).toEqual(draft); } finally { await reader.close(); }
      } else if (kind === "encrypt") {
        await decryptOpeningArchive(destination, `${source}.restored`, passphrase);
        expect(await fs.readFile(`${source}.restored`, "utf8")).toBe("complete backup bytes");
      } else expect(await fs.readFile(destination, "utf8")).toBe("complete backup bytes");
    },
  };
}
afterEach(async () => {
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link);
  vi.mocked(fs.rm).mockReset().mockImplementation(actual.rm);
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
});

describe.each(["archive", "encrypt", "decrypt"] as const)("%s publication failures", (kind) => {
  it.each(["EXDEV", "ENOTSUP"])("fails closed when exclusive publication fails with %s", async (code) => {
    const output = await fixture(kind);
    vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error("exclusive publication unavailable"), { code }));
    await expect(output.run()).rejects.toMatchObject({ code });
    await expect(fs.stat(output.destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(output.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reports already-published output when its own temporary-file cleanup fails", async () => {
    const output = await fixture(kind);
    vi.mocked(fs.rm).mockImplementation(async (target, options) => {
      if (String(target).startsWith(`${output.destination}.`) && String(target).endsWith(".tmp")) {
        throw Object.assign(new Error("temporary unlink denied"), { code: "EPERM" });
      }
      return actual.rm(target, options);
    });
    const error: unknown = await output.run().then(() => undefined, (caught: unknown) => caught);
    expect(error).toMatchObject({ published: true, destination: output.destination });
    await output.verify();
    const temporary = (await fs.readdir(output.root)).find((name) => name.startsWith("published.") && name.endsWith(".tmp"));
    expect(temporary).toBeDefined();
    const [temporaryStat, publishedStat] = await Promise.all([
      fs.stat(path.join(output.root, temporary!)), fs.stat(output.destination),
    ]);
    // Real same-volume hard links retain the full file after either name is removed.
    expect(temporaryStat.ino).toBe(publishedStat.ino);
    expect(publishedStat.nlink).toBe(2);
  });

  it("never removes another writer's temporary file after a name collision", async () => {
    const output = await fixture(kind);
    const temporary = `${output.destination}.00000000-0000-4000-8000-000000000001.tmp`;
    const legacyTemporary = `${output.destination}.0000000000000000.tmp`;
    for (const target of [temporary, legacyTemporary]) {
      await fs.writeFile(target, "other temporary owner", { encoding: "utf8", flag: "wx" });
    }
    await expect(output.run()).rejects.toMatchObject({ code: "EEXIST" });
    for (const target of [temporary, legacyTemporary]) {
      expect(await fs.readFile(target, "utf8")).toBe("other temporary owner");
    }
    await expect(fs.stat(output.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
