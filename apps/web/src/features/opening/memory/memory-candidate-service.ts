import {
  createOpeningMemoryRepository,
  OpeningMemoryError,
  type OpeningMemoryRepository,
} from "@aistudy/database";
import {
  memoryCandidateDecisionSchema,
  type MemoryCandidateDecision,
  type MemoryItem,
} from "@aistudy/contracts";
import { memoryCardMeta } from "@aistudy/domain";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";

function scopeOf(principal: Principal) {
  return { workspaceId: boundWorkspaceId(principal), ownerUserId: principal.userId };
}

function mapDecisionError(error: unknown): never {
  if (error instanceof OpeningMemoryError) {
    if (error.code === "NOT_FOUND") throw new ApiError("NOT_FOUND", error.message, 404);
    if (error.code === "VALIDATION" && error.message.includes("temporary memory")) {
      throw new ApiError("VALIDATION", error.message, 422);
    }
    if (error.code === "VALIDATION") throw new ApiError("VALIDATION", error.message, 400);
    throw new ApiError("CONFLICT", error.message, 409);
  }
  throw error;
}

export type MemoryCandidateCard = MemoryItem & { why: string[]; when: string };

function toCard(item: MemoryItem): MemoryCandidateCard {
  const meta = memoryCardMeta(item);
  return { ...item, why: meta.why, when: meta.when };
}

export function createOpeningMemoryCandidateService(
  repo: Pick<OpeningMemoryRepository, "decideMemoryCandidate">,
) {
  return {
    async decideCandidate(
      principal: Principal,
      input: MemoryCandidateDecision,
    ): Promise<MemoryCandidateCard> {
      assertAuthorized(principal, "memory.decide", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      const decision = memoryCandidateDecisionSchema.parse(input);
      try {
        const item = await repo.decideMemoryCandidate(scopeOf(principal), decision);
        return toCard(item);
      } catch (error) {
        mapDecisionError(error);
      }
    },
  };
}

export function createOpeningMemoryCandidateServiceFromSql(sql: Sql) {
  return createOpeningMemoryCandidateService(createOpeningMemoryRepository(sql));
}
