import {
  createOpeningSourceRepository,
  OpeningSourceError,
  type OpeningSourceRepository,
} from "@aistudy/database";
import {
  uploadInputSchema,
  type SourceRecord,
  type UploadInput,
  type UploadTicket,
} from "@aistudy/contracts";
import type { Sql } from "postgres";
import { createHash } from "node:crypto";
import {
  validateStoredUpload,
  UploadPolicyError,
} from "./upload-policy";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";

export type StagingReceipt = {
  bytes: number;
  sha256: string;
  mime: string;
};

/** Process-local staging receipts — stub until real S3 (no Docling/jobs). */
const stagingReceipts = new Map<string, StagingReceipt>();

export function clearOpeningSourceStagingForTests(): void {
  stagingReceipts.clear();
}

export function createOpeningSourceService(sql: Sql) {
  const sources: OpeningSourceRepository = createOpeningSourceRepository(sql);

  function scopeOf(principal: Principal) {
    return {
      workspaceId: boundWorkspaceId(principal),
      ownerUserId: principal.userId,
    };
  }

  return {
    async listSources(principal: Principal): Promise<SourceRecord[]> {
      assertAuthorized(principal, "source.list", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      return sources.list(scopeOf(principal));
    },

    async beginUpload(
      principal: Principal,
      input: UploadInput,
      stagingAbsoluteUrl: string,
    ): Promise<UploadTicket> {
      assertAuthorized(principal, "source.create", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      const parsed = uploadInputSchema.parse(input);
      const source = await sources.create(scopeOf(principal), parsed);
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      return {
        source,
        uploadUrl: stagingAbsoluteUrl.replace("__SOURCE_ID__", source.id),
        expiresAt,
      };
    },

    async putStaging(
      principal: Principal,
      sourceId: string,
      body: Uint8Array,
      contentType: string | null,
    ): Promise<void> {
      assertAuthorized(principal, "source.upload", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      const source = await sources.get(scopeOf(principal), sourceId);
      if (source.uploadState !== "pending") {
        throw new OpeningSourceError(
          "CONFLICT",
          `cannot stage uploadState=${source.uploadState}`,
        );
      }
      if (body.byteLength !== source.bytes) {
        throw new UploadPolicyError(
          `staged bytes ${body.byteLength} != expected ${source.bytes}`,
        );
      }
      const sha256 = createHash("sha256").update(body).digest("hex");
      const mime = contentType?.split(";")[0]?.trim() || source.mime;
      stagingReceipts.set(sourceId, { bytes: body.byteLength, sha256, mime });
    },

    async completeUpload(
      principal: Principal,
      sourceId: string,
    ): Promise<SourceRecord> {
      assertAuthorized(principal, "source.complete", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      const scope = scopeOf(principal);
      const source = await sources.get(scope, sourceId);
      const receipt = stagingReceipts.get(sourceId);
      if (!receipt) {
        throw new UploadPolicyError("staged object missing; PUT staging first");
      }
      validateStoredUpload(
        {
          name: source.name,
          mime: source.mime,
          bytes: source.bytes,
          sha256: source.sha256,
        },
        receipt,
      );
      const completed = await sources.complete(scope, sourceId, receipt);
      stagingReceipts.delete(sourceId);
      return completed;
    },
  };
}

export type OpeningSourceService = ReturnType<typeof createOpeningSourceService>;
