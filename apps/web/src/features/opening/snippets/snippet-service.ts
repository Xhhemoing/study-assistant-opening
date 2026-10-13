import { loadFeatureSwitches } from "@aistudy/config";
import { snippetCreateInputSchema } from "@aistudy/contracts";
import { createOpeningNoteRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";
import { markdownToNoteBlocks } from "./markdown-blocks";

export function createOpeningSnippetService(sql: Sql, env: NodeJS.ProcessEnv = process.env) {
  const notes = createOpeningNoteRepository(sql);
  return {
    async save(principal: Principal, raw: unknown) {
      const workspaceId = boundWorkspaceId(principal);
      assertAuthorized(principal, "document.create", { type: "document", workspaceId });
      const input = snippetCreateInputSchema.parse(raw);
      // Notes keep the answer's structure only where chat renders it as Markdown too.
      const structured = loadFeatureSwitches(env).chatProse ? markdownToNoteBlocks(input.text).blocks : undefined;
      return notes.saveSnippet({ workspaceId, ownerUserId: principal.userId }, input, structured);
    },
  };
}
