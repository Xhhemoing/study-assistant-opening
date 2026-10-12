import { describe, expect, it } from "vitest";
import { windowsCommand } from "../../scripts/run-heavy.mjs";

describe("run-heavy Windows command", () => {
  it("runs bash -c chains as a single shell line", () => {
    expect(windowsCommand(["bash", "-c", "tsc -p a --noEmit && tsc -p b --noEmit"])).toBe("tsc -p a --noEmit && tsc -p b --noEmit");
  });

  it("quotes arguments containing spaces or quotes", () => {
    expect(windowsCommand(["vitest", "run", "--project", "unit"])).toBe("vitest run --project unit");
    expect(windowsCommand(["node", "a b.mjs", 'x"y'])).toBe('node "a b.mjs" "x\\"y"');
  });
});

