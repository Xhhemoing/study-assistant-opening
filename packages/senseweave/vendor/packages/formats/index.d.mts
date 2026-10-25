import type {Block} from '../core/document.mjs';
export type InputFormat='auto'|'markdown'|'csv'|'tsv'|'json'|'diff'|'mermaid'|'latex';
export interface ColumnHint {key:string;kind?:'nominal'|'ordinal'|'quantitative'|'temporal';unit?:string}
export interface FormatOptions {inputFormat?:InputFormat;columns?:ColumnHint[];final?:boolean}
export interface FormatCandidate {id:string;start:number;end:number;format:string;block:Block;source:string}
export const INPUT_FORMATS: readonly InputFormat[];
export function parseDelimited(text:string,delimiter?:','|'\t'):{header:string[];rows:string[][]};
export function parseMermaid(text:string): {nodes:{id:string;label:string}[];edges:{from:string;to:string;relation:'sequence'}[]};
export function parseLatex(text:string): import('../core/document.mjs').MathExpression;
export function discoverFormats(text:string,options?:FormatOptions):{candidates:FormatCandidate[];diagnostics:import('../runtime/index.mjs').Diagnostic[]};
