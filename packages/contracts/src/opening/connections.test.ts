import { describe, expect, it } from "vitest";
import { imapSetupInputSchema } from "./connections";

const input = {
  label: "School mail", host: "imap.example.edu", port: 993, tlsMode: "implicit",
  username: "learner", folders: ["INBOX"], since: "2026-11-01T00:00:00Z", clientKey: "test-fixture",
};

describe("IMAP setup endpoint", () => {
  it.each(["localhost", "imap.localhost", "127.0.0.1", "127.1", "0x7f000001", "10.0.0.1", "100.64.0.1", "169.254.169.254", "fd00::1", "[::1]"])(
    "rejects local hosts and IP literals (%s)", host => {
      expect(imapSetupInputSchema.safeParse({ ...input, host }).success).toBe(false);
    },
  );

  it.each([[993, "starttls"], [143, "implicit"], [25, "starttls"], [143, "plaintext"]])(
    "rejects unapproved port and mode %s/%s", (port, tlsMode) => {
      expect(imapSetupInputSchema.safeParse({ ...input, port, tlsMode }).success).toBe(false);
    },
  );

  it.each([[993, "implicit"], [143, "starttls"]])("accepts %s/%s", (port, tlsMode) => {
    expect(imapSetupInputSchema.safeParse({ ...input, port, tlsMode }).success).toBe(true);
  });
});
