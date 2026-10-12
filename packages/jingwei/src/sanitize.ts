/**
 * Unsafe-content rules for untrusted block params. Single owner of "what counts as
 * a dangerous URL / markup / handler" for every host. Renderers still escape text;
 * this only rejects shapes no catalog renderer should ever receive.
 */

const UNSAFE_URL_PREFIX = /^\s*(?:javascript:|data:|vbscript:)/i;
const MARKUP_KEYS = new Set(["html", "script", "dangerouslySetInnerHTML", "innerHTML", "srcdoc"]);
const URL_KEYS = new Set(["href", "url", "src", "action", "xlinkHref", "xlink:href", "formAction"]);
export const PARAMS_MAX_DEPTH = 8;

export type UnsafeContentKind = "link" | "markup" | "handler" | "depth";
export type UnsafeContentFinding = { kind: UnsafeContentKind; path: string };

export function isUnsafeUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return UNSAFE_URL_PREFIX.test(trimmed) || /javascript\s*:/i.test(trimmed);
}

export function isMarkupKey(key: string): boolean {
  return MARKUP_KEYS.has(key);
}

export function isHandlerKey(key: string): boolean {
  return /^on[A-Z]/.test(key) || key === "actionHandler";
}

/**
 * First unsafe shape found anywhere in `value`, or null. Plain prose that merely
 * mentions "javascript:" is allowed; only URL-valued keys are checked as links.
 */
export function findUnsafeContent(value: unknown, path = "", depth = 0): UnsafeContentFinding | null {
  if (value === null || typeof value !== "object") return null;
  if (depth >= PARAMS_MAX_DEPTH) return { kind: "depth", path };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findUnsafeContent(value[i], `${path}[${i}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isMarkupKey(key)) return { kind: "markup", path: childPath };
    if (isHandlerKey(key)) return { kind: "handler", path: childPath };
    if (URL_KEYS.has(key) && isUnsafeUrl(child)) return { kind: "link", path: childPath };
    const found = findUnsafeContent(child, childPath, depth + 1);
    if (found) return found;
  }
  return null;
}
