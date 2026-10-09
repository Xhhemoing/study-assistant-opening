/**
 * Internal DingTalk capability names ↔ official-doc surface (verified 2026-10-06).
 *
 * These strings are Opening-owned; they must never be sent as DingTalk OAuth scopes.
 *
 * | Internal capability | Official surface (not an OAuth scope string)                                      |
 * |---------------------|-----------------------------------------------------------------------------------|
 * | messages.read       | Robot receive-message / event callback payload only; no historical group-chat API |
 * | events.read         | Event subscription callback after验签/解密 (orgapp/events, event-subscriptions)   |
 * | files.read          | Attachment bytes only from verified callback resources + allowlisted download host|
 * | robot.send          | Async corp conversation send (oapi …/asyncsend_v2) — NOT a read capability        |
 *
 * `robot.send` must never satisfy `messages.read` / `events.read` / `files.read`.
 */
export function canReadDingTalkResource(
  requiredScope: string,
  grantedScopes: string[],
): boolean {
  return grantedScopes.includes(requiredScope);
}
