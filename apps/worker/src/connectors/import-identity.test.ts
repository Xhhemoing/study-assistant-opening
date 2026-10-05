import { describe, expect, it } from "vitest";
import { importIdentityKey } from "./import-identity";
const base = { connectionId: "11111111-1111-4111-8111-111111111111", container: "INBOX", generation: "1", remoteId: "9" };
describe("import identity", () => { it("does not conflate mailbox generations", () => { expect(importIdentityKey(base)).not.toBe(importIdentityKey({ ...base, generation: "2" })); }); });
