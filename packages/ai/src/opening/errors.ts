export type ProviderFailure = {
  retryable: boolean;
  code: string;
};

export function classifyProviderFailure(status: number): ProviderFailure {
  if (status === 401 || status === 403) {
    return { retryable: false, code: "PROVIDER_AUTH" };
  }
  if (status === 429) {
    return { retryable: true, code: "PROVIDER_RATE_LIMIT" };
  }
  if (status >= 500) {
    return { retryable: true, code: "PROVIDER_UNAVAILABLE" };
  }
  return { retryable: false, code: "PROVIDER_REQUEST" };
}
