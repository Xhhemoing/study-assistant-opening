export type LegacySearchParams = Record<string, string | string[] | undefined>;

/** Keep repeated filters, pinned versions and return addresses when following an old bookmark. */
export function openingAliasHref(pathname: string, search: LegacySearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value)) value.forEach(item => query.append(key, item));
    else if (value !== undefined) query.append(key, value);
  }
  return `${pathname}${query.size ? `?${query}` : ""}`;
}
