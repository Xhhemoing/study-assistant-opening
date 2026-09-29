import { snippetCreateInputSchema } from "@aistudy/contracts";
import { createOpeningNoteRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";

export function createOpeningSnippetService(sql: Sql) {
  const notes = createOpeningNoteRepository(sql);
  return {
    async save(principal: Principal, raw: unknown) {
      const workspaceId = boundWorkspaceId(principal);
      assertAuthorized(principal, "document.create", { type: "document", workspaceId });
      return notes.saveSnippet({ workspaceId, ownerUserId: principal.userId }, snippetCreateInputSchema.parse(raw));
    },
  };
}
