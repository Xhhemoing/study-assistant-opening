export function canReadDingTalkResource(
  requiredScope: string,
  grantedScopes: string[],
): boolean {
  return grantedScopes.includes(requiredScope);
}
