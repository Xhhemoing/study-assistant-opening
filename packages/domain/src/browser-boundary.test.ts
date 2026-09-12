import { describe, expect, it } from "vitest";
import * as browserDomain from "./index";
import { sha256Hex } from "./portability/native/files";

describe("domain browser/server boundary", () => {
  it("does not export native backup operations from the browser entry", () => {
    expect(browserDomain).not.toHaveProperty("buildNativeBackup");
    expect(browserDomain).not.toHaveProperty("planNativeRestore");
    expect(browserDomain).not.toHaveProperty("sha256Hex");
    expect(browserDomain).toHaveProperty("NativeBackupError");
  });

  it("preserves the native SHA-256 implementation", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
