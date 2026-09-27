import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpeningBackup } from "@aistudy/domain";
import { readOpeningBackupArchive, writeOpeningBackupArchive } from "./opening-backup-archive";
import { decryptOpeningArchive, encryptOpeningArchive } from "./opening-backup-cipher";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof fs>("node:fs/promises");
const roots: string[] = [];
const passphrase = "exclusive publication test";
const draft: OpeningBackup = {
  format: "opening-backup", version: 1, workspaceId: "a1000000-0000-4000-8000-000000000001",
  privacyEpoch: 0, deletionJournal: [], tables: {}, objects: [],
};

async function fixture(kind: "archive" | "encrypt" | "decrypt") {
  const root = await fs.mkdtemp(path.join(tmpdir(), "opening-exclusive-"));
  roots.push(root);
  const source = path.join(root, "source");
  const destination = path.join(root, "published");
  await fs.writeFile(source, "complete backup bytes", "utf8");
  if (kind === "decrypt") await encryptOpeningArchive(source, `${source}.enc`, passphrase);
  return {
    destination,
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

function gateTemporaryOpen(destination: string) {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (String(args[0]).startsWith(`${destination}.`) && String(args[0]).endsWith(".tmp")) {
      entered();
      await resume;
    }
    return handle;
  });
  return { ready, release };
}

afterEach(async () => {
  vi.mocked(fs.open).mockImplementation(actual.open);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.each(["archive", "encrypt", "decrypt"] as const)("%s exclusive publication", (kind) => {
  it("does not expose a destination before its bytes are complete", async () => {
    const output = await fixture(kind);
    const gate = gateTemporaryOpen(output.destination);
    const writing = output.run();
    try {
      await Promise.race([gate.ready, writing]);
      await expect(fs.stat(output.destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      gate.release();
      await writing;
    }
    await output.verify();
  });

  it("preserves a competing writer that publishes while output is being written", async () => {
    const output = await fixture(kind);
    const gate = gateTemporaryOpen(output.destination);
    const writing = output.run();
    const result = writing.then(() => undefined, (error: unknown) => error);
    try {
      await Promise.race([gate.ready, writing]);
      // A competing owner may replace a legacy empty reservation with its complete file.
      await fs.rm(output.destination, { force: true });
      await fs.writeFile(output.destination, "other complete writer", { encoding: "utf8", flag: "wx" });
    } finally { gate.release(); }
    expect(await result).toBeInstanceOf(Error);
    expect(await fs.readFile(output.destination, "utf8")).toBe("other complete writer");
    expect((await fs.readdir(path.dirname(output.destination))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
