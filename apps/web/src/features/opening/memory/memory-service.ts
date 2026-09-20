import {
  createOpeningMemoryRepository,
  OpeningMemoryError,
  type OpeningMemoryRepository,
} from "@aistudy/database";
import {
  memoryDecisionSchema,
  memoryVisibleInCourseScope,
  type MemoryDecision,
  type MemoryItem,
} from "@aistudy/contracts";
import {
  memoriesForContext,
  memoriesForReview,
  memoryCardMeta,
} from "@aistudy/domain";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";
import { createOpeningPrivacyService } from "./privacy-service";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";

function scopeOf(p: Principal) {
  return { workspaceId: boundWorkspaceId(p), ownerUserId: p.userId };
}

function mapMemoryError(error: unknown): never {
  if (error instanceof OpeningMemoryError) {
    if (error.code === "NOT_FOUND") throw new ApiError("NOT_FOUND", error.message, 404);
    if (error.code === "VALIDATION") throw new ApiError("VALIDATION", error.message, 400);
    throw new ApiError("CONFLICT", error.message, 409);
  }
  throw error;
}

export type MemoryCard = MemoryItem & { why: string[]; when: string };

function toCard(item: MemoryItem): MemoryCard {
  const meta = memoryCardMeta(item);
  return { ...item, why: meta.why, when: meta.when };
}

export function createOpeningMemoryService(sql: Sql) {
  const repo: OpeningMemoryRepository = createOpeningMemoryRepository(sql);
  return {
    async listMemory(principal: Principal, courseId: string | null = null) {
      assertAuthorized(principal, "memory.list", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      const now = new Date().toISOString();
      const items = await repo.list(scopeOf(principal), courseId);
      const scoped = items.filter((item) =>
        memoryVisibleInCourseScope(item.courseId, courseId),
      );
      return {
        items: scoped.map(toCard),
        context: memoriesForContext(scoped, now).map(toCard),
        review: memoriesForReview(scoped).map(toCard),
      };
    },

    async propose(
      principal: Principal,
      input: {
        text: string;
        sourceTurnIds?: string[];
        expiresAt?: string | null;
        courseId?: string | null;
      },
    ): Promise<MemoryCard> {
      assertAuthorized(principal, "memory.propose", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      try {
        const item = await repo.proposeMemory(scopeOf(principal), {
          text: input.text,
          sourceTurnIds: input.sourceTurnIds ?? [],
          expiresAt: input.expiresAt ?? null,
          courseId: input.courseId ?? null,
        });
        return toCard(item);
      } catch (error) {
        mapMemoryError(error);
      }
    },

    async decideMemory(principal: Principal, input: MemoryDecision): Promise<MemoryCard> {
      assertAuthorized(principal, "memory.decide", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      const decision = memoryDecisionSchema.parse(input);
      try {
        if (decision.action === "delete") {
          const receipt = await createOpeningPrivacyService(sql).deleteMemory(principal, {
            id: decision.id,
            expectedVersion: decision.expectedVersion,
            clientKey: decision.clientKey,
            deleteSourceText: false,
          });
          return {
            id: receipt.memoryId,
            workspaceId: receipt.workspaceId,
            courseId: null,
            kind: "confirmed",
            text: "[deleted]",
            sourceTurnIds: [],
            version: decision.expectedVersion + 1,
            expiresAt: null,
            status: "deleted",
            createdAt: receipt.deletedAt,
            updatedAt: receipt.deletedAt,
            why: [],
            when: receipt.deletedAt,
          };
        }
        if (decision.action === "confirm") {
          const item = await repo.confirm(
            scopeOf(principal),
            decision.id,
            decision.expectedVersion,
            decision.clientKey,
          );
          return toCard(item);
        }
        const item = await repo.reject(
          scopeOf(principal),
          decision.id,
          decision.expectedVersion,
          decision.clientKey,
        );
        return toCard(item);
      } catch (error) {
        mapMemoryError(error);
      }
    },
  };
}

export type OpeningMemoryService = ReturnType<typeof createOpeningMemoryService>;
