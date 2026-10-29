export type JSONValue = null | string | number | boolean | JSONValue[] | {[key: string]: JSONValue};
export type Source = {
  id: string;
  title: string;
  url?: string | null;
  excerpt?: string;
  locator?: string;
  access: 'available' | 'restricted' | 'missing';
};
export type Matrix2 = [[number, number], [number, number]];
export type MathExpression =
  | {op: 'text' | 'number' | 'symbol'; value: string}
  | {op: 'row' | 'frac' | 'sup' | 'sub' | 'sqrt'; args: MathExpression[]};
export type BlockData = {
  table: {columns: {key: string; label: string; kind?: 'nominal' | 'ordinal' | 'quantitative' | 'temporal'; unit?: string; /** Original Markdown inline source; label stays plain text. */ inline?: string}[]; rows: (string | number | boolean | null)[][]; /** Original inline source, aligned with rows and columns. */ inlineRows?: (string | null)[][]};
  plot: {kind: 'line' | 'scatter'; xKind?: 'quantitative' | 'temporal' | 'ordinal'; xLabel?: string; yLabel?: string; yUnit: string; points: {x: string | number; y: number | null}[]; note?: string};
  json: {value: JSONValue};
  diff: {patch: string};
  details: {items: {summary: string; body: string}[]};
  /** Line-by-line board derivation. Every line is verbatim answer text; may reveal a final answer, so hint-style hosts should leave it out of capabilities.components. */
  derivation: {lines: {text: string; note?: string}[]};
  prose: Record<string, never>;
  callout: Record<string, never>;
  steps: {items: string[]};
  compare: {columns: string[]; rows: string[][]};
  code: {language?: string; code: string};
  math: {expression: MathExpression};
  chart: {unit: string; rows: {label: string; value: number}[]; note?: string};
  matrix: {matrix: Matrix2};
  diagram: {
    direction?: 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
    nodes: {id: string; label: string; shape?: 'rect' | 'round' | 'diamond' | 'stadium'}[];
    edges: {from: string; to: string; relation: 'sequence' | 'dependency' | 'hypothesis'; label?: string; style?: 'solid' | 'dashed' | 'thick'}[];
  };
  evidence: {
    claims: {
      text: string;
      relation: 'supported' | 'inferred' | 'contested' | 'missing';
      sourceIds?: string[];
    }[];
  };
  exercise: {question: string; answer: string; hints?: string[]};
  calc: {
    inputs: {
      id: string;
      label: string;
      value: number;
      min: number;
      max: number;
      step?: number;
      unit?: string;
    }[];
    outputs: {
      id: string;
      label: string;
      expr: string;
      unit?: string;
      digits?: number;
      primary?: boolean;
    }[];
  };
  timeline: {items: {when: string; title: string; detail?: string}[]};
  checklist: {items: {id: string; text: string}[]};
};
export type Block = {
  [K in keyof BlockData]: {
    id: string;
    type: K;
    title?: string;
    body?: string;
    /** Only honoured on prose/callout; renders the safe Markdown subset. */
    format?: K extends 'prose' | 'callout' ? 'text' | 'markdown' : never;
    refs?: string[];
    qualifiers?: string[];
    /** Runtime-only (placement 'replace'): the verbatim answer span this component stands in for. Never honoured on prose. */
    original?: string;
    data: BlockData[K];
  };
}[keyof BlockData];
export interface PresentationDocument {
  schemaVersion: '0.2';
  id: string;
  revision: number;
  /** Set by patchBlock: the producer revision a local edit started from (< revision). */
  baseRevision?: number;
  title: string;
  summary?: string;
  blocks: Block[];
  warnings?: string[];
  sources?: Source[];
  originalText?: string;
  /** Runtime findings (unresolved bindings, number contradictions); recomputed, never input. */
  readonly checks?: string[];
}
export type Scope = {values: Map<string, number>; digits: Map<string, number>};
export type Overrides = Record<string, Record<string, number>>;
export function documentScope(doc: PresentationDocument, overrides?: Overrides): Scope;
export function calcValues(
  data: BlockData['calc'],
  overrides?: Record<string, number>
): Map<string, number>;
export function bindText(text: string, scope: Scope): string;
export function resolveBinding(
  src: string,
  digits: string | undefined,
  scope: Scope
): {ok: true; value: number; text: string} | {ok: false};
export function consistencyWarnings(doc: PresentationDocument): string[];
export function formatNumber(value: number, digits?: number): string;
export class ContractError extends Error {
  code: string;
  constructor(code: string, message: string);
}
export const SCHEMA_VERSION: '0.2';
export const CATALOG: Readonly<Record<keyof BlockData, string>>;
export function validateDocument(
  input: unknown,
  options?: {sources?: Source[]; partial?: boolean}
): PresentationDocument;
export function plainDocument(
  text: string,
  id?: string,
  title?: string,
  options?: {format?: 'text' | 'markdown'}
): PresentationDocument;
export function splitText(text: string, max?: number): string[];
export function normalizeSources(sources?: unknown[]): Source[];
export function mathText(tree: MathExpression): string;
export function projectText(
  doc: PresentationDocument,
  options?: {includeAnswers?: boolean; includeOriginal?: boolean; overrides?: Overrides}
): string;
export function exportDocument(doc: PresentationDocument): PresentationDocument;
export function patchBlock(
  doc: PresentationDocument,
  blockId: string,
  replacement: Block,
  expectedRevision: number
): PresentationDocument;
export function matrixFrame(
  matrix: Matrix2,
  t?: number
): {matrix: Matrix2; determinant: number; area: number; e1: number[]; e2: number[]; t: number};
export function validateMatrix(matrix: unknown): Matrix2;
export function validateMath(tree: unknown): MathExpression;
export function safeUrl(value: unknown): string | null;
export function migrateLab(input: unknown): PresentationDocument;
export function requireContract(ok: unknown, code: string, message: string): asserts ok;
export function validId(input: unknown): string;
export function cleanText(input: unknown, max?: number): string;
export function isRecord(input: unknown): input is Record<string, unknown>;

export function validateGraph(data: unknown): BlockData['diagram'];
export function layoutDiagram(data: BlockData['diagram']): {
  nodes: (BlockData['diagram']['nodes'][number] & {x: number; y: number})[];
  width: number;
  height: number;
  cyclic: boolean;
  dense: boolean;
};
