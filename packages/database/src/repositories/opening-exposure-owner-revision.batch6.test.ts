import { expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Sql } from "postgres";
import { createOpeningStudyExposureRepository } from "./opening-study-exposure";
const hooks = vi.hoisted(() => ({ lock: vi.fn(), resolve: vi.fn(), invalidate: vi.fn(), courseRevision: vi.fn(), workspaceRevision: vi.fn() }));
vi.mock("./opening-study-context", () => ({ resolveOpeningStudyContext: hooks.resolve }));
vi.mock("./opening-learning-eligibility", () => ({ invalidateOpeningLearningEligibility: hooks.invalidate }));
vi.mock("./opening-learning-facts", async original => ({ ...await original<typeof import("./opening-learning-facts")>(),
  lockWorkspaceLearningHistory: hooks.lock, nextLearningHistoryRevision: hooks.courseRevision, nextWorkspaceLearningHistoryRevision: hooks.workspaceRevision }));
const stamp = "2026-11-10T00:00:00.000Z";
const a = { workspaceId: "a-workspace", ownerUserId: "a-owner", courseId: "a-course", receiptId: "a-receipt", rootId: "a-root", revision: 11, workspaceRevision: 21 };
const b = { workspaceId: "b-workspace", ownerUserId: "b-owner", courseId: "b-course", receiptId: "b-receipt", rootId: "b-root", revision: 12, workspaceRevision: 22 };
const scope = (v: typeof a) => ({ workspaceId: v.workspaceId, ownerUserId: v.ownerUserId });
function row(v: typeof a) { return { id: v.receiptId, workspace_id: v.workspaceId, owner_user_id: v.ownerUserId, release_key: `key-${v.receiptId}`,
  context_anchor: { purpose: "learning_help", courseId: v.courseId }, exposure_origin: "assistant", support_domain: "unknown",
  generated_at: stamp, released_at: null, acknowledged_at: null, history_revision: 0, course_id: v.courseId, session_id: null, attempt_id: null, problem_id: null }; }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
// The receipt predicate is a conjunction of simple equalities and one null
// guard. Reject unsupported shapes; do not discard unknown SQL or bindings.
function receiptLookupPredicates(parts: TemplateStringsArray, values: unknown[]) {
  const sql = parts.reduce((out, part, i) => out + (i ? `$${i}` : "") + part, "").replace(/\s+/g, " ").trim();
  // Comments and OR can hide or weaken predicates; never strip them.
  expect(sql).not.toMatch(/--|\/\*|\*\/|\bOR\b/i);
  const match = /^SELECT (?:\*|([a-z_]\w*)\.\*) FROM opening_help_exposures(?:\s+(?:AS\s+)?([a-z_]\w*))? WHERE (.+) FOR UPDATE$/i.exec(sql);
  expect(match, "receipt SELECT must retain the row lock").not.toBeNull();
  if (!match) return null;
  const alias = match[2]?.toLowerCase();
  if (match[1]) expect(match[1].toLowerCase()).toBe(alias);
  // Consume the entire restricted grammar. Parentheses may wrap whole
  // conjunctions or a NOT-null operand, never identifier/keyword fragments.
  const predicateText = match[3]!;
  let position = 0;
  const tokens = /\s*(\$\d+|[a-z_]\w*(?:\.[a-z_]\w*)?|[()=])/gi;
  const pieces: string[] = [];
  while (position < predicateText.length) {
    tokens.lastIndex = position;
    const token = tokens.exec(predicateText);
    expect(token?.index, "unsupported SQL token").toBe(position);
    if (!token || token.index !== position) return null;
    pieces.push(token[1]!); position = tokens.lastIndex;
  }
  let cursor = 0;
  const take = (token: string) => { if (pieces[cursor]?.toUpperCase() === token) { cursor++; return true; } return false; };
  const required = (token: string) => { expect(take(token), `expected ${token} at token ${cursor}`).toBe(true); };
  const predicates: string[] = [];
  function conjunction(): void {
    function term(): void {
      if (take("(")) { conjunction(); required(")"); return; }
      if (take("NOT")) { required("("); const col = pieces[cursor++]; required("IS"); required("NULL"); required(")"); predicates.push(`NOT ${col} IS NULL`); return; }
      const left = pieces[cursor++];
      if (take("=")) { const right = pieces[cursor++]; predicates.push(`${left}=${right}`); return; }
      required("IS"); required("NOT"); required("NULL"); predicates.push(`${left} IS NOT NULL`);
    }
    term(); while (take("AND")) term();
  }
  conjunction();
  expect(cursor, "unexpected trailing SQL token").toBe(pieces.length);
  expect(predicates).toHaveLength(4);
  const bindings: Record<string, unknown> = {};
  let guardCount = 0;
  for (const predicate of predicates) {
    const qualifier = alias ? `(?:${alias}\\.)?` : "";
    if (new RegExp(`^(?:${qualifier}release_key\\s+IS\\s+NOT\\s+NULL|NOT\\s+${qualifier}release_key\\s+IS\\s+NULL)$`, "i").test(predicate)) { guardCount++; continue; }
    const column = `(${qualifier}(?:id|workspace_id|owner_user_id))`;
    const equality = new RegExp(`^${column}\\s*=\\s*\\$(\\d+)$`, "i").exec(predicate)
      ?? new RegExp(`^\\$(\\d+)\\s*=\\s*${column}$`, "i").exec(predicate);
    expect(equality, `unsupported receipt predicate: ${predicate}`).not.toBeNull();
    if (!equality) continue;
    const firstIsNumber = /^\d+$/.test(equality[1]!);
    const field = (firstIsNumber ? equality[2]! : equality[1]!).toLowerCase().split(".").at(-1)!;
    const index = Number(firstIsNumber ? equality[1] : equality[2]) - 1;
    expect(Object.hasOwn(bindings, field), `duplicate ${field} predicate`).toBe(false);
    expect(index).toBeGreaterThanOrEqual(0); expect(index).toBeLessThan(values.length);
    bindings[field] = values[index];
  }
  expect(guardCount).toBe(1);
  expect(values).toHaveLength(3);
  return bindings;
}
it("keeps owner, course revision, workspace revision and root invalidation scoped across a forced interleaving", async () => {
  vi.clearAllMocks(); const reached = gate(), proceed = gate(); let count = 0;
  const transactions = new Map<string, unknown>();
  const operation = new AsyncLocalStorage<typeof a>();
  const assertContext = (tx: unknown, currentScope: { workspaceId: string; ownerUserId: string }) => {
    const v = operation.getStore();
    expect(v).toBeDefined();
    if (!v) throw new Error("missing originating operation context");
    expect(currentScope).toEqual(scope(v)); expect(tx).toBe(transactions.get(v.workspaceId)); return v;
  };
  hooks.lock.mockImplementation(async (tx, currentScope) => { assertContext(tx, currentScope); });
  hooks.resolve.mockImplementation(async (tx, currentScope, anchor) => {
    assertContext(tx, currentScope);
    if (currentScope.workspaceId === a.workspaceId) { reached.release(); await proceed.promise; }
    return anchor;
  });
  hooks.courseRevision.mockImplementation(async (_tx, currentScope, courseId) => {
    const v = assertContext(_tx, currentScope);
    expect(courseId).toBe(v.courseId); return v.revision;
  });
  hooks.workspaceRevision.mockImplementation(async (tx, currentScope) => assertContext(tx, currentScope).workspaceRevision);
  hooks.invalidate.mockImplementation(async (tx, currentScope, input) => {
    const v = assertContext(tx, currentScope); expect(input).toEqual({ rootIds: [v.rootId] });
  });
  const events: Array<{ actor: string; sql: string; values: unknown[] }> = [];
  const sql = Object.assign(vi.fn(), { begin: async (fn: (tx: unknown) => Promise<unknown>) => {
    const actor = count++ === 0 ? a : b;
    const tx = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const q = parts.join("?").replace(/\s+/g, " ").trim(); events.push({ actor: actor.workspaceId, sql: q, values });
      if (/^SELECT (?:\*|[a-z_]\w*\.\*) FROM opening_help_exposures\b/i.test(q)) {
        expect(receiptLookupPredicates(parts, values)).toEqual({ id: actor.receiptId, workspace_id: actor.workspaceId, owner_user_id: actor.ownerUserId });
        return [row(actor)];
      }
      if (q.startsWith("UPDATE opening_help_exposures SET delivered=TRUE")) {
        expect(values).toEqual([actor.revision, actor.workspaceRevision, actor.receiptId]);
        return [{ ...row(actor), released_at: stamp, history_revision: actor.revision }];
      }
      if (q.startsWith("SELECT DISTINCT COALESCE")) {
        // Entire nested root selection is checked, including all OR grouping.
        // Only whitespace changes are normalized; this is not a general SQL parser.
        const expected = `SELECT DISTINCT COALESCE(o.root_observation_id,o.id) AS root_id FROM opening_learning_observations o
          WHERE o.workspace_id=? AND o.owner_user_id=?
          AND (? OR o.course_id IS NOT DISTINCT FROM ?::uuid)
          AND (o.attempt_id=? OR o.problem_id=?
          OR (? AND (o.session_id=?
          OR (? AND o.source_ids @> ?::uuid[])
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(?::jsonb->'originReference'->'sourceRefs','[]'::jsonb)) ref
          WHERE ref->>'sourceId'=ANY(o.source_ids::text[]) AND ?::jsonb->'originReference'->>'skillLabel'=o.skill_label))))`;
        expect(q.replace(/\s+/g, " ").trim()).toBe(expected.replace(/\s+/g, " ").trim());
        expect(values).toEqual([actor.workspaceId, actor.ownerUserId, false, actor.courseId,
          null, null, true, null, false, [], null, null]);
        return [{ root_id: actor.rootId }];
      }
      throw new Error(`Unsupported SQL: ${q}`);
    }), { json: (value: unknown) => value });
    transactions.set(actor.workspaceId, tx);
    return fn(tx);
  } });
  const repo = createOpeningStudyExposureRepository(sql as unknown as Sql);
  const first = operation.run(a, () => repo.release(scope(a), a.receiptId));
  const settled = first.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    const arrival = await Promise.race([reached.promise.then(() => ({ arrived: true as const })), settled.then(result => ({ arrived: false as const, result }))]);
    if (!arrival.arrived) {
      if (!arrival.result.ok) throw arrival.result.error;
      throw new Error("A completed before reaching the gate");
    }
    const second = await operation.run(b, () => repo.release(scope(b), b.receiptId));
    expect(second).toMatchObject({ id: b.receiptId, historyRevision: b.revision, releasedAt: stamp });
    expect(hooks.invalidate).toHaveBeenCalledTimes(1);
    expect(hooks.invalidate.mock.calls[0]!.slice(1)).toEqual([scope(b), { rootIds: [b.rootId] }]);
  } finally { proceed.release(); await settled; }
  const result = await first;
  expect(result).toMatchObject({ id: a.receiptId, historyRevision: a.revision, releasedAt: stamp });
  expect(hooks.invalidate.mock.calls[1]!.slice(1)).toEqual([scope(a), { rootIds: [a.rootId] }]);
  expect(events.filter(e => e.sql.startsWith("UPDATE opening_help_exposures")).map(e => e.actor)).toEqual([b.workspaceId, a.workspaceId]);
  expect(hooks.lock.mock.calls.map(c => c[1])).toEqual([scope(a), scope(b)]);
});
