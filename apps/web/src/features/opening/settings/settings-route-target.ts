const sections: Record<string, "learning" | "ai"> = {
  planning: "learning", preferences: "learning", intervention: "learning",
  "quick-model-setup": "ai", connections: "ai", "daily-budget": "ai", export: "ai", developer: "ai", memory: "ai",
};

export function settingsHashTarget(basePath: string, hash: string, search = ""): string | null {
  const anchor = hash.replace(/^#/, "");
  if (!Object.hasOwn(sections, anchor)) return null;
  const section = sections[anchor];
  if (!section) return null;
  const query = new URLSearchParams(search);
  if (anchor === "planning") query.set("planning", "1");
  return `${basePath}/${section}${query.size ? `?${query}` : ""}#${anchor}`;
}

export function settingsRedirectQuery(params: Record<string, string | string[] | undefined>, extra?: Record<string, string>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach(item => query.append(key, item));
    else if (value !== undefined) query.append(key, value);
  }
  for (const [key, value] of Object.entries(extra ?? {})) query.set(key, value);
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}
