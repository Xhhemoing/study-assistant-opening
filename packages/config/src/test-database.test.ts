import { describe, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "./test-database";

describe("assertOpeningTestDatabase", () => {
  it("refuses destructive tests without explicit isolated database", () => {
    expect(() =>
      assertOpeningTestDatabase("postgres://u:p@localhost/aistudy", "1"),
    ).toThrow();
    expect(() =>
      assertOpeningTestDatabase(
        "postgres://u:p@example.org/aistudy_opening_test",
        "1",
      ),
    ).toThrow();
    expect(() =>
      assertOpeningTestDatabase(
        "postgres://u:p@localhost/aistudy_opening_test",
        undefined,
      ),
    ).toThrow();
  });

  it("accepts loopback URL with exact database name and OPENING_TEST_DB=1", () => {
    const url = assertOpeningTestDatabase(
      "postgres://u:p@127.0.0.1:5432/aistudy_opening_test",
      "1",
    );
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/aistudy_opening_test");
  });
});
