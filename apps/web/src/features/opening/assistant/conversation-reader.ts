import type { ConversationResume, TurnRecord } from "@aistudy/contracts";
import type { JobStatusResponse, OpeningApi } from "../client/api";
import { sameUnknownJob } from "./unknown-turn-recovery";

type ReadApi = Pick<OpeningApi, "resumeConversation" | "listTurns" | "getPendingJob">;
export type ConversationSnapshot = {
  resume: ConversationResume;
  turns: TurnRecord[];
  pending: { kind: "ready"; job: JobStatusResponse | null }
    | { kind: "changed" }
    | { kind: "unavailable"; error: unknown };
};

/** The latest read owns the UI; late requests cannot overwrite a newer conversation snapshot. */
export function createConversationReader(api: ReadApi) {
  let version = 0;
  let current: AbortController | null = null;
  const cancel = () => { version += 1; current?.abort(); current = null; };
  return {
    cancel,
    async read(id: string, signal?: AbortSignal): Promise<ConversationSnapshot | null> {
      cancel();
      const readingVersion = version;
      const controller = new AbortController();
      current = controller;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const active = () => !controller.signal.aborted && version === readingVersion;
      try {
        if (!active()) return null;
        const [resume, initialTurns] = await Promise.all([
          api.resumeConversation(id, controller.signal), api.listTurns(id, controller.signal),
        ]);
        if (!active()) return null;
        let turns = initialTurns;
        let pending: ConversationSnapshot["pending"];
        try {
          const job = await api.getPendingJob(id, controller.signal);
          if (!active()) return null;
          if (job?.status === "outcome_unknown") {
            // A second tab may submit between the independent history and job reads.
            turns = await api.listTurns(id, controller.signal);
            const confirmed = await api.getPendingJob(id, controller.signal);
            if (!active()) return null;
            pending = sameUnknownJob(job, confirmed) ? { kind: "ready", job } : { kind: "changed" };
          } else if (!job && turns.some(turn => turn.status === "pending")) {
            // Completion can land between the history and pending-job reads.
            // Read history again so a finished answer cannot remain stuck at “生成中”.
            turns = await api.listTurns(id, controller.signal);
            const confirmed = await api.getPendingJob(id, controller.signal);
            if (!active()) return null;
            pending = confirmed ? { kind: "changed" } : { kind: "ready", job: null };
          } else {
            pending = { kind: "ready", job };
          }
        } catch (error) {
          if (!active()) return null;
          pending = { kind: "unavailable", error };
        }
        return { resume, turns, pending };
      } catch (error) {
        if (!active()) return null;
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (version === readingVersion) current = null;
      }
    },
  };
}
