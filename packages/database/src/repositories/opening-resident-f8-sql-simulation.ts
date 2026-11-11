// Test-only tagged SQL transport. No PostgreSQL client or connection is constructed.
// Recognises only the statements exercised here. Not a SQL engine or concurrency proof.
import type { Sql, TransactionSql } from 'postgres';
export type Query = { text: string; values: unknown[] };
export type Responder = (query: Query) => unknown[] | Promise<unknown[]>;
type Fragment = { fragment: boolean; text: string; values: unknown[] };
type QueryResult = Fragment & PromiseLike<unknown[]>;
export function sqlSimulation(respond: Responder) {
  const queries: Query[] = [];
  function tag(strings: TemplateStringsArray | unknown[], ...values: unknown[]): Fragment | QueryResult {
    if (!('raw' in strings)) return { fragment: true, text: '(?)', values: [strings] };
    let text = strings[0]! as string; const bindings: unknown[] = [];
    values.forEach((value, i) => {
      if (value && typeof value === 'object' && 'fragment' in value) {
        const fragment = value as { fragment: true; text: string; values: unknown[] };
        text += fragment.text; bindings.push(...fragment.values);
      } else { text += '?'; bindings.push(value); }
      text += strings[i + 1]! as string;
    });
    const query = { text: text.replace(/\s+/g, ' ').trim(), values: bindings };
    let result: Promise<unknown[]> | undefined;
    return { fragment: true, ...query, then<TResult1 = unknown[], TResult2 = never>(resolve?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null, reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) {
      if (!result) { queries.push(query); result = Promise.resolve().then(() => respond(query)); }
      return result.then(resolve, reject);
    } };
  }
  tag.json = (value: unknown) => value;
  tag.unsafe = (text: string) => ({ fragment: true, text, values: [] });
  return { sql: tag as unknown as Sql & TransactionSql, queries };
}
export function unexpected(query: Query): never { throw new Error(`UNEXPECTED SQL: ${query.text}`); }
export function hasScope(query: Query, scope: { workspaceId: string; ownerUserId: string }, prefix = '') {
  const workspaceField = query.text.startsWith('SELECT id FROM workspaces') ? 'id' : `${prefix}workspace_id`;
  const workspace = fieldValue(query, workspaceField), owner = fieldValue(query, `${prefix}owner_user_id`);
  // Missing SQL guards expose the fixture row, like a missing WHERE predicate;
  // never manufacture NOT_FOUND just because the guard disappeared.
  return (workspace === undefined || workspace === scope.workspaceId)
    && (owner === undefined || owner === scope.ownerUserId);
}
// Find equality bindings in the observed production statement. Removing a WHERE guard
// changes simulated row visibility, rather than being hidden by a canned empty response.
export function fieldValue(query: Query, field: string): unknown {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[\\s(])${escaped}\\s*=\\s*\\?`).exec(query.text);
  if (!match) return undefined;
  const index = (query.text.slice(0, match.index + match[0].lastIndexOf('?')).match(/\?/g) ?? []).length;
  return query.values[index];
}
export function fixtureVisible(query: Query, row: Record<string, unknown>, fields: string[]) {
  return fields.every(field => {
    const value = fieldValue(query, field);
    return value === undefined || value === row[field.replace(/^.*\./, '')];
  });
}
