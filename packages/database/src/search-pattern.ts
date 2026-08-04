/**
 * Escapes a user query for use inside a PostgreSQL ILIKE pattern with the
 * default backslash escape. Returns the escaped fragment WITHOUT surrounding
 * wildcards; callers wrap it with `%...%`.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function wrapLikePattern(query: string): string {
  return `%${escapeLikePattern(query)}%`;
}
