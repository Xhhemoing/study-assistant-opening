import { describe, expect, it } from "vitest";
import { mailToImportInput, nextImapCursor } from "./imap-sync";

describe("imap sync cursor and parser guards", () => {
  it("never moves a committed UID cursor backwards", () => {
    expect(nextImapCursor({ folder: "INBOX", uidValidity: "7", lastUid: 10 }, 9).lastUid).toBe(10);
    expect(nextImapCursor({ folder: "INBOX", uidValidity: "7", lastUid: 10 }, 12).lastUid).toBe(12);
  });

  it("keeps mailbox generations separate", () => {
    expect(nextImapCursor({ folder: "INBOX", uidValidity: "7", lastUid: 0 }, 12))
      .toEqual({ folder: "INBOX", uidValidity: "7", lastUid: 12 });
  });

  it("parses bounded text mail without remote content or path-like attachment names", () => {
    const input = mailToImportInput({
      mail: {
        subject: "Lesson",
        text: "hello",
        html: "<p>remote</p>",
        attachments: [{
          filename: "../evil.png",
          contentType: "image/png",
          content: new Uint8Array([1, 2, 3]),
        }],
      },
    });
    expect(input.subject).toBe("Lesson");
    expect(input.bodyText).toBe("hello");
    expect(input.attachments[0]?.filename).toBe("evil.png");
    expect(input.attachments[0]?.size).toBe(3);
  });
});
