import type {Block} from './document.mjs';
export const COMPARE_HEADERS: readonly string[];
export function normalizeForGrounding(value: unknown): string;
export function sourceNumbers(source: string): Set<number>;
/** Exact contiguous occurrence (only leading/trailing whitespace of the quote is ignored). */
export function isVerbatimQuote(quote: unknown, text: string): boolean;
/** Values in block.data that do not occur in source (empty = grounded). */
export function groundingViolations(block: {type: string; data: unknown}, source: string, options?: {extraLabels?: string[]}): (string | number)[];
export function isGrounded(block: {type: string; data: unknown}, source: string, options?: {extraLabels?: string[]}): boolean;
export function validateProposalBlock(block: {id: string; type: string; data: unknown}): Block;
/** Build steps/checklist/chart/plot/timeline/compare/derivation from a compact proposal shape. Validated, not yet grounded. */
export function buildProposalBlock(type: string, data: unknown, id: string): Block;
