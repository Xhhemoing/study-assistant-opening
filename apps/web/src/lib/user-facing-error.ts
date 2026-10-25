const CJK = /[\u4e00-\u9fff]/;
// Messages that leak transport, parser or schema internals even when they contain Chinese.
const TECHNICAL = /request failed|invalid (json )?request|unexpected token|failed to fetch|networkerror|load failed|"code"\s*:|"path"\s*:|\[\s*\{|zod|client-init|undefined|NaN/i;

function isSchemaError(reason: Error): boolean {
  return reason.name === "ZodError" || ("issues" in reason && Array.isArray((reason as { issues?: unknown }).issues));
}

/**
 * Learner-facing text for an unknown failure. Only short, human (Chinese) messages that the app
 * itself authored pass through; schema/parse/network/English server messages fall back to the
 * caller's localized copy, so ZodError JSON, "request failed (500)" or "Invalid credentials"
 * never render in the learning UI.
 */
export function userFacingMessage(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback;
  if (reason instanceof SyntaxError || reason instanceof TypeError || reason.name === "AbortError" || isSchemaError(reason)) return fallback;
  const message = reason.message.trim();
  if (!message || message.length > 300 || !CJK.test(message) || TECHNICAL.test(message)) return fallback;
  return message;
}
