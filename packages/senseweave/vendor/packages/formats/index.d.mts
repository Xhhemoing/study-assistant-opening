import type {Block} from '../core/document.mjs';
export type InputFormat='auto'|'markdown'|'csv'|'tsv'|'json'|'diff'|'mermaid'|'latex';
export interface ColumnHint {key:string;kind?:'nominal'|'ordinal'|'quantitative'|'temporal';unit?:string}
export interface FormatOptions {inputFormat?:InputFormat;columns?:ColumnHint[];final?:boolean}
export interface Fidelity {level:'exact'|'projection'|'derived'|'lossy';losses:string[];calculation?:string}
export type SourceReference={kind:'text';start:number;end:number}|{kind:'snapshot';id:string}|{kind:'authored';blockId:string};
export interface FieldProjection {xKey:string;yKey:string;omittedKeys:string[];rowMapping:'identity'}
export interface FormatCandidate {id:string;start:number;end:number;format:string;block:Block;source:string;fidelity?:Fidelity;sourceRef?:SourceReference;projection?:FieldProjection}
export const INPUT_FORMATS: readonly InputFormat[];
export function parseDelimited(text:string,delimiter?:','|'\t'):{header:string[];rows:string[][]};
export function parseMermaid(text:string): {nodes:{id:string;label:string}[];edges:{from:string;to:string;relation:'sequence'}[]};
export function parseLatex(text:string): import('../core/document.mjs').MathExpression;
export function discoverFormats(text:string,options?:FormatOptions):{candidates:FormatCandidate[];diagnostics:import('../runtime/index.mjs').Diagnostic[]};
/** Zero-call implicit structure in prose (steps, checklist, chart/plot, timeline, compare, derivation). Every value is verbatim and grounded. */
export function discoverProseStructures(text:string,context?:{instruction?:string;tasks?:string[];derive?:boolean}):(FormatCandidate&{implicit:'sequence'|'enumeration'|'series'|'events'|'comparison'|'derivation';placement:'replace'|'after'})[];
