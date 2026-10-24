/** Internal selection policy only. The caller owns authorization, privacy/source admission,
 * and loading the complete, stably ordered parent list (oldest first). Never feed a
 * timestamp-filtered or per-ancestor truncated list here. No database or model calls. */
export type BranchRelation = "deepen" | "rephrase" | "related";
export type BranchSourceRef = Readonly<{ sourceId: string; sourceVersion: number }>;
export type BranchContextTurn = Readonly<{
  id: string;
  text: string;
  status: string;
  querySystem: boolean;
  /** Includes legacy receipts even when querySystem is false. */
  hasSystemQueryReceipt: boolean;
  /** Full consumed lineage, already admitted by the server; null means unknown. */
  sourceRefs: readonly BranchSourceRef[] | null;
}>;
export type BranchParentExchange = Readonly<{
  /** The paired user turn ID, not a timestamp or an unpaired assistant ID. */
  exchangeId: string;
  conversationId: string;
  user: BranchContextTurn;
  assistant: BranchContextTurn | null;
}>;
export type BranchFragment = Readonly<{
  turnId: string;
  /** UTF-16 offsets, end exclusive; checked against the server-loaded text. */
  start: number;
  end: number;
  text: string;
}>;
export type BranchContextInput = Readonly<{
  parentConversationId: string;
  parentListComplete: boolean;
  exchanges: readonly BranchParentExchange[];
  forkExchangeId: string;
  relation: BranchRelation;
  purpose: "model" | "record_referents";
  /** deepen/related require one explicit fragment of the fork exchange. */
  fragment?: BranchFragment;
  /** deepen/related: at most two explicitly supplied earlier exchanges. No auto expansion. */
  backgroundExchangeIds?: readonly string[];
  /** May lower, never raise, the shared budget. No depth-dependent multiplier. */
  budget?: Readonly<{ maxCharacters: number; maxExchanges: number }>;
}>;
export type BranchInheritedMessage = Readonly<{
  role: "user" | "assistant";
  text: string;
  exchangeId: string;
  turnId: string;
  range: Readonly<{ start: number; end: number }>;
}>;
export type BranchContextFailure = "incomplete_parent" | "invalid_exchange" | "fork_missing"
  | "invalid_selection" | "query_context" | "invalid_budget" | "budget_exceeded";
export type BranchContextResult =
  | { ok: false; reason: BranchContextFailure }
  | {
    ok: true;
    policyVersion: 1;
    relation: BranchRelation;
    purpose: BranchContextInput["purpose"];
    returnAnchor: { conversationId: string; exchangeId: string; turnId: string };
    messages: BranchInheritedMessage[];
    sourceRefs: BranchSourceRef[];
    /** Ordered manifest of exchanges actually consumed, suitable for later persistence. */
    exchangeIds: string[];
    characters: number;
    truncated: boolean;
  };

export const BRANCH_CONTEXT_LIMITS = { maxCharacters: 12_000, maxExchanges: 20, maxBackgroundExchanges: 2 } as const;

/** Reject missing/incomplete boundaries; select by list index, never by timestamps.
 * Ancestors, if needed later, must be supplied in one admitted list and share this budget.
 * This function does not establish grants or make revoked material admissible. */
export function selectConversationBranchContext(input: BranchContextInput): BranchContextResult {
  const fail = (reason: BranchContextFailure): BranchContextResult => ({ ok: false, reason });
  if (!input.parentListComplete) return fail("incomplete_parent");
  const limit = input.budget ?? BRANCH_CONTEXT_LIMITS;
  if (!Number.isSafeInteger(limit.maxCharacters) || limit.maxCharacters < 1
    || limit.maxCharacters > BRANCH_CONTEXT_LIMITS.maxCharacters
    || !Number.isSafeInteger(limit.maxExchanges) || limit.maxExchanges < 1
    || limit.maxExchanges > BRANCH_CONTEXT_LIMITS.maxExchanges) return fail("invalid_budget");
  const ids = new Set<string>();
  const turnIds = new Set<string>();
  for (const exchange of input.exchanges) {
    if (!exchange.exchangeId || exchange.exchangeId !== exchange.user.id
      || exchange.conversationId !== input.parentConversationId || ids.has(exchange.exchangeId)) return fail("invalid_exchange");
    ids.add(exchange.exchangeId);
    for (const turn of [exchange.user, exchange.assistant]) {
      if (turn) {
        if (!turn.id || turnIds.has(turn.id)) return fail("invalid_exchange");
        turnIds.add(turn.id);
      }
    }
  }
  const forkIndex = input.exchanges.findIndex(exchange => exchange.exchangeId === input.forkExchangeId);
  if (forkIndex < 0) return fail("fork_missing");
  const prefix = input.exchanges.slice(0, forkIndex + 1);
  // Unknown lineage and an incomplete exchange cannot silently collapse the fork boundary.
  if (prefix.some(exchange => !exchange.assistant || [exchange.user, exchange.assistant].some(turn =>
    turn.status !== "complete" || !turn.text.trim() || turn.sourceRefs === null))) return fail("incomplete_parent");
  const fork = prefix[forkIndex]!;
  const isQuery = (exchange: BranchParentExchange) => exchange.user.querySystem || exchange.user.hasSystemQueryReceipt
    || exchange.assistant!.querySystem || exchange.assistant!.hasSystemQueryReceipt;
  if (input.purpose === "model" && isQuery(fork)) return fail("query_context");
  const fullMessages = (exchange: BranchParentExchange): BranchInheritedMessage[] => {
    const turns = input.purpose === "record_referents" ? [exchange.user] : [exchange.user, exchange.assistant!];
    return turns.map((turn, index) => ({ role: index === 0 ? "user" : "assistant", text: turn.text,
      exchangeId: exchange.exchangeId, turnId: turn.id, range: { start: 0, end: turn.text.length } }));
  };
  let candidates: { exchange: BranchParentExchange; messages: BranchInheritedMessage[] }[];
  if (input.relation === "rephrase") {
    if (input.fragment || input.backgroundExchangeIds?.length) return fail("invalid_selection");
    candidates = prefix.filter(exchange => input.purpose !== "model" || !isQuery(exchange))
      .map(exchange => ({ exchange, messages: fullMessages(exchange) }));
  } else if (input.relation === "deepen" || input.relation === "related") {
    const fragment = input.fragment;
    const turn = [fork.user, fork.assistant!].find(item => item.id === fragment?.turnId);
    if (!fragment || !turn || !Number.isSafeInteger(fragment.start) || !Number.isSafeInteger(fragment.end)
      || fragment.start < 0 || fragment.end <= fragment.start || fragment.end > turn.text.length
      || turn.text.slice(fragment.start, fragment.end) !== fragment.text || !fragment.text.trim()) return fail("invalid_selection");
    const background = input.backgroundExchangeIds ?? [];
    if (background.length > BRANCH_CONTEXT_LIMITS.maxBackgroundExchanges || new Set(background).size !== background.length
      || background.some(id => !prefix.slice(0, forkIndex).some(exchange => exchange.exchangeId === id))) return fail("invalid_selection");
    candidates = prefix.slice(0, forkIndex).filter(exchange => background.includes(exchange.exchangeId))
      .filter(exchange => input.purpose !== "model" || !isQuery(exchange))
      .map(exchange => ({ exchange, messages: fullMessages(exchange) }));
    // Query referent resolution retains user wording only, never assistant state assertions.
    if (input.purpose === "record_referents" && turn !== fork.user) return fail("invalid_selection");
    const messages: BranchInheritedMessage[] = [{
      role: turn === fork.user ? "user" : "assistant", text: fragment.text, exchangeId: fork.exchangeId,
      turnId: turn.id, range: { start: fragment.start, end: fragment.end },
    }];
    candidates.push({ exchange: fork, messages });
  } else return fail("invalid_selection");

  let characters = 0;
  const selected: typeof candidates = [];
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index]!;
    if (!candidate.messages.length) continue;
    const size = candidate.messages.reduce((sum, message) => sum + message.text.length, 0);
    if (characters + size > limit.maxCharacters || selected.length >= limit.maxExchanges) {
      if (candidate.exchange === fork) return fail("budget_exceeded");
      break; // A bounded contiguous suffix; never skip a large pair to pull older context.
    }
    characters += size;
    selected.unshift(candidate);
  }
  const refs = new Map<string, BranchSourceRef>();
  for (const { exchange } of selected) {
    // Conservatively retain both sides' admitted lineage, including record referents.
    for (const turn of [exchange.user, exchange.assistant!]) for (const ref of turn.sourceRefs!) {
      const sourceId = ref.sourceId.toLowerCase();
      refs.set(`${sourceId}:${ref.sourceVersion}`, { sourceId, sourceVersion: ref.sourceVersion });
    }
  }
  return {
    ok: true, policyVersion: 1, relation: input.relation, purpose: input.purpose,
    returnAnchor: { conversationId: input.parentConversationId, exchangeId: fork.exchangeId, turnId: fork.assistant!.id },
    messages: selected.flatMap(candidate => candidate.messages), sourceRefs: [...refs.values()],
    exchangeIds: selected.map(candidate => candidate.exchange.exchangeId), characters,
    truncated: selected.length < candidates.filter(candidate => candidate.messages.length > 0).length,
  };
}
