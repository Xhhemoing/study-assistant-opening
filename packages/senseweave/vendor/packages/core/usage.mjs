import {cleanText, requireContract} from './document.mjs';

export function normalizeProviderUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const {inputTokens, outputTokens, totalTokens, cost} = value;
  if (![inputTokens, outputTokens, totalTokens].every(x => Number.isSafeInteger(x) && x >= 0) || totalTokens < inputTokens + outputTokens) return null;
  if (cost !== undefined && (!cost || !Number.isFinite(cost.amount) || cost.amount < 0 || typeof cost.currency !== 'string' || !/^[A-Z]{3}$/.test(cost.currency))) return null;
  return {inputTokens, outputTokens, totalTokens, ...(cost ? {cost: {amount: cost.amount, currency: cost.currency}} : {})};
}

export function validateReviewTelemetry(value) {
  requireContract(value && typeof value === 'object' && Number.isInteger(value.calls) && value.calls >= 0 && value.calls <= 1, 'DECISION', '语义复核说明不合法');
  const usage = value.usage == null ? null : normalizeProviderUsage(value.usage);
  requireContract(value.usage == null || usage, 'DECISION', '复核用量不合法');
  requireContract(value.latencyMs === undefined || Number.isSafeInteger(value.latencyMs) && value.latencyMs >= 0, 'DECISION', '复核延迟不合法');
  return {status: cleanText(value.status, 40), calls: value.calls,
    ...(value.reason === undefined ? {} : {reason: cleanText(value.reason, 300)}),
    ...(value.requestId === undefined ? {} : {requestId: cleanText(value.requestId, 80)}),
    ...(value.latencyMs === undefined ? {} : {latencyMs: value.latencyMs}),
    usage, usageStatus: usage ? 'reported' : 'unknown', costStatus: usage?.cost ? 'reported' : 'unknown'};
}
