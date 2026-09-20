import { createOpeningMemoryRepository, OpeningMemoryError } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";

function scopeOf(p: Principal) {
  return { workspaceId: boundWorkspaceId(p), ownerUserId: p.userId };
}

function mapErr(error: unknown): never {
  if (error instanceof OpeningMemoryError) {
    if (error.code === "NOT_FOUND") throw new ApiError("NOT_FOUND", error.message, 404);
    if (error.code === "VALIDATION") throw new ApiError("VALIDATION", error.message, 400);
    throw new ApiError("CONFLICT", error.message, 409);
  }
  throw error;
}

/** User-facing memory deletion with privacy epoch + content-free exclusions. */
export function createOpeningPrivacyService(sql: Sql) {
  const memories = createOpeningMemoryRepository(sql);
  return {
    async deleteMemory(
      principal: Principal,
      input: {
        id: string;
        expectedVersion: number;
        clientKey: string;
        deleteSourceText?: boolean;
      },
    ) {
      assertAuthorized(principal, "memory.delete", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      try {
        return await memories.deleteMemory(scopeOf(principal), {
          id: input.id,
          expectedVersion: input.expectedVersion,
          clientKey: input.clientKey,
          deleteSourceText: input.deleteSourceText ?? false,
        });
      } catch (error) {
        mapErr(error);
      }
    },
  };
}

export type OpeningPrivacyService = ReturnType<typeof createOpeningPrivacyService>;
