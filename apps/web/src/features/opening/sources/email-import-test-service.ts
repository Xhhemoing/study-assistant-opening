import {
  uploadInputSchema,
  type SourceRecord,
  type UploadInput,
  type UploadTicket,
} from "@aistudy/contracts";
import type { Sql } from "postgres";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";

const source: SourceRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  name: "lesson.eml",
  mime: "message/rfc822",
  bytes: 58,
  sha256: "b".repeat(64),
  version: 0,
  uploadState: "uploaded",
  parseState: "ready",
  error: null,
  createdAt: "2026-10-06T00:00:00.000Z",
};

/** Used only by the opening email import handler test. */
export function createOpeningEmailImportTestSourceService(sql: Sql) {
  void sql;
  return {
    async beginUpload(p: Principal, input: UploadInput): Promise<UploadTicket> {
      await assertAuthorized(p, "source.create", { type: "workspace", workspaceId: boundWorkspaceId(p) });
      const parsed = uploadInputSchema.parse(input);
      return {
        source: { ...source, name: parsed.name, bytes: parsed.bytes, sha256: parsed.sha256, uploadState: "pending", parseState: "not_started" },
        uploadUrl: "https://staging.test/upload",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
    },
    async completeUpload(p: Principal, id: string): Promise<SourceRecord> {
      await assertAuthorized(p, "source.complete", { type: "workspace", workspaceId: boundWorkspaceId(p) });
      if (id !== source.id) throw new Error("unexpected source id");
      return source;
    },
  };
}
