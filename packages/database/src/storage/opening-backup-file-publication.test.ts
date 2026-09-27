import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeExclusiveOpeningBackupFile } from "./opening-backup-file-publication";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), rm: vi.fn(actual.rm) };
});
const actual = await vi.importActual<typeof fs>("node:fs/promises");
const roots: string[] = [];
async function scratch() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "opening-file-publication-"));
  roots.push(root);
  return { root, destination: path.join(root, "output") };
}
afterEach(async () => {
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.rm).mockReset().mockImplementation(actual.rm);
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
});

describe("opening backup temporary-file ownership", () => {
  it.each([false, true])("reports unpublished plaintext cleanup failure with an existing destination=%s", async (exists) => {
    const { root, destination } = await scratch();
    if (exists) await fs.writeFile(destination, "other complete backup", { encoding: "utf8", flag: "wx" });
    const writeError = new Error("write interrupted after partial plaintext");
    const cleanupError = Object.assign(new Error("temporary unlink denied"), { code: "EPERM" });
    vi.mocked(fs.rm).mockImplementation(async (target, options) => {
      if (String(target).startsWith(`${destination}.`) && String(target).endsWith(".tmp")) throw cleanupError;
      return actual.rm(target, options);
    });
    const error: unknown = await writeExclusiveOpeningBackupFile(destination, "output already exists", async (handle) => {
      await handle.writeFile("sensitive partial archive", "utf8");
      throw writeError;
    }).then(() => undefined, (caught: unknown) => caught);
    const temporary = (await fs.readdir(root)).find((name) => name.endsWith(".tmp"));
    expect(temporary).toBeDefined();
    const temporaryPath = path.join(root, temporary!);
    expect(error).toMatchObject({
      published: false, destination, temporaryPath, cleanupError, cause: writeError,
    });
    expect((error as Error).cause).toBe(writeError);
    expect(await fs.readFile(temporaryPath, "utf8")).toBe("sensitive partial archive");
    if (exists) expect(await fs.readFile(destination, "utf8")).toBe("other complete backup");
    else await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requests owner-only creation permissions for the complete temporary file", async () => {
    const { destination } = await scratch();
    await writeExclusiveOpeningBackupFile(destination, "output already exists", async (handle) => {
      await handle.writeFile("private archive", "utf8");
    });
    expect(fs.open).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), "wx", 0o600);
    expect(await fs.readFile(destination, "utf8")).toBe("private archive");
    // Windows mode bits do not prove ACL protection. Exercise the actual permission result on POSIX only.
    if (process.platform !== "win32") expect((await fs.stat(destination)).mode & 0o077).toBe(0);
  });
});
