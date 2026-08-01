import { describe, expect, it } from "vitest";
import { assertE2eDatabaseUrl } from "../../scripts/db-reset-e2e";

describe("browser E2E database guard", () => {
  it("rejects a database URL that is not isolated for E2E", () => {
    expect(() =>
      assertE2eDatabaseUrl("postgres://aistudy:aistudy@127.0.0.1:5432/aistudy"),
    ).toThrow("must target a database whose name ends in _e2e");
  });

  it("allows an isolated E2E database URL", () => {
    expect(() =>
      assertE2eDatabaseUrl("postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_e2e"),
    ).not.toThrow();
  });
});
