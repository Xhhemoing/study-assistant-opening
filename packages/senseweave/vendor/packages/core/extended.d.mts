import type {BlockData} from './document.mjs';
export const EXTENDED_CATALOG: Readonly<Record<'table'|'plot'|'json'|'diff'|'details'|'derivation', string>>;
export function normalizeExtended(type: string, data: unknown): unknown;
export function extendedText(type: string, data: unknown): string;
export function validISODate(value: string): boolean;
export function niceTicks(min: number, max: number, count?: number): number[];
export const MAX_TABLE_ROWS: number;
export function plotGeometry(data: BlockData['plot']): {w:number;h:number;pad:number;xmin:number;xmax:number;ymin:number;ymax:number;zeroY:number;points: {x:string|number;y:number|null;px:number;py:number|null}[];segments: {x:string|number;y:number;px:number;py:number}[][]};
