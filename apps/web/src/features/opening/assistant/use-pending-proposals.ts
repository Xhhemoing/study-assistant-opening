import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantProposalRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { userFacingMessage } from "../../../lib/user-facing-error";

type State = { scope: string; rows: AssistantProposalRecord[]; total: number; cursor: string | null; loading: boolean; error: string };
const empty = (scope: string): State => ({ scope, rows: [], total: 0, cursor: null, loading: false, error: "" });

/** One owner per surface; a late read cannot cross a conversation boundary. */
export function usePendingProposals(api: Pick<OpeningApi, "listPendingAssistantProposals">,
  options: { enabled?: boolean; conversationId?: string; retain?: (row: AssistantProposalRecord) => boolean } = {}, refreshKey = "") {
  const enabled = options.enabled !== false;
  const conversationId = options.conversationId;
  const retain = options.retain;
  const scope = enabled ? conversationId ?? "all" : "disabled";
  const [state, setState] = useState<State>(() => empty(scope));
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    loadingMore.current = false;
    if (!enabled) { setState(empty(scope)); return; }
    setState(previous => ({ ...(previous.scope === scope ? previous : empty(scope)), loading: true, error: "" }));
    try {
      const response = await api.listPendingAssistantProposals(conversationId ? { conversationId } : {});
      if (request === generation.current) setState(previous => {
        const ids = new Set(response.proposals.map(row => `${row.id}:${row.version}`));
        const retained = previous.scope === scope ? previous.rows.filter(row => retain?.(row) && !ids.has(`${row.id}:${row.version}`)) : [];
        return { scope, rows: [...response.proposals, ...retained], total: response.total, cursor: response.nextCursor, loading: false, error: "" };
      });
    } catch (error) {
      if (request === generation.current) setState(previous => ({ ...previous, loading: false, error: userFacingMessage(error, "建议暂时无法读取，请重试。") }));
    }
  }, [api, enabled, conversationId, scope, retain]);
  useEffect(() => {
    void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener("opening:reviews-changed", changed);
    return () => { generation.current++; window.removeEventListener("opening:reviews-changed", changed); };
  }, [refresh, refreshKey]);
  const visible = state.scope === scope ? state : empty(scope);
  async function loadMore() {
    if (!enabled || !visible.cursor || visible.loading || loadingMore.current) return;
    const request = generation.current;
    loadingMore.current = true;
    setState(previous => ({ ...previous, loading: true, error: "" }));
    try {
      const response = await api.listPendingAssistantProposals({ ...(conversationId ? { conversationId } : {}), cursor: visible.cursor });
      if (request === generation.current) setState(previous => ({ ...previous,
        rows: [...new Map([...previous.rows, ...response.proposals].map(row => [row.id, row])).values()],
        cursor: response.nextCursor, total: response.total, loading: false }));
    } catch (error) {
      if (request === generation.current) setState(previous => ({ ...previous, loading: false, error: userFacingMessage(error, "更多建议暂时无法读取，请重试。") }));
    } finally { if (request === generation.current) loadingMore.current = false; }
  }
  return { ...visible, refresh, loadMore };
}
export type PendingProposalsState = ReturnType<typeof usePendingProposals>;
