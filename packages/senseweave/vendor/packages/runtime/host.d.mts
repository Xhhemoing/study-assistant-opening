import type {Block, PresentationDocument, Source} from '../core/document.mjs';
import type {OutputEnvelope, RuntimeOptions} from './index.mjs';
import type {PresentationPolicy, PresentationTask} from '../policy/index.mjs';
import type {CapabilityInput} from './capabilities.mjs';
export type TextSegment = {kind: 'text'; start: number; end: number; source: string};
export type BlockSegment = {
  kind: 'block';
  start: number;
  end: number;
  source: string;
  type: Exclude<Block['type'], 'prose'>;
  blockId: string;
  reasons: string[];
  /** Present on supplementary views: shown in place of its span ('replace') or after it ('append', source ''). */
  placement?: 'replace' | 'append';
  /** 'replace' only: the verbatim span the block stands in for (equals source); offer it as “查看原文”. */
  original?: string;
  document: PresentationDocument;
};
export type OutputSegment = TextSegment | BlockSegment;
/** Ordered, lossless split of envelope.content: joining every segment's source returns the content. */
export function segmentOutput(
  envelope: OutputEnvelope,
  options?: {sources?: Source[]; /** Overrides the envelope's own choice for supplementary views. */ placement?: 'replace' | 'append'}
): OutputSegment[];
export type TeachingPresetName =
  | 'hint'
  | 'explain'
  | 'derive'
  | 'review'
  | 'compare'
  | 'plan'
  | 'data';
export interface TeachingPreset {
  readonly context: {readonly task: PresentationTask};
  readonly capabilities: Readonly<CapabilityInput>;
  readonly policy: Readonly<PresentationPolicy>;
  readonly intent: string;
  readonly note?: string;
}
export const TEACHING_PRESETS: Readonly<Record<TeachingPresetName, TeachingPreset>>;
/** Merge a preset into runtime options; values the host passes explicitly win. */
export function teachingOptions(name: TeachingPresetName, options?: RuntimeOptions): RuntimeOptions;
export interface HostAdapterOptions {
  preset?: TeachingPresetName;
  /** Answers shorter than this stay text (counted as skippedShort). Default 0. */
  minChars?: number;
  sources?: Source[];
  /** Supplementary views in place of their span ('replace', default) or after it ('append'). */
  placement?: 'replace' | 'append';
  preferences?: {
    maxEntries?: number;
    initial?: Record<string, {positive: number; negative: number}>;
    onChange?: (snapshot: Record<string, {positive: number; negative: number}>) => void;
  };
  options?: RuntimeOptions;
}
export interface PreparedAnswer {
  preset: TeachingPresetName;
  segments: OutputSegment[];
  enhanced: boolean;
  decision: OutputEnvelope['decision'] | null;
  diagnostics: OutputEnvelope['diagnostics'];
  /** Contract code when the input itself was rejected; segments then hold the whole text. */
  error: string | null;
  ms: number;
  extraModelCalls: 0;
}
export interface HostAdapterStats {
  answers: number;
  enhanced: number;
  skippedShort: number;
  fallbacks: number;
  byType: Record<string, number>;
  byPreset: Record<string, number>;
  enhancementRate: number;
  p50Ms: number;
  p95Ms: number;
  extraModelCalls: 0;
}
export interface HostAdapter {
  readonly presets: TeachingPresetName[];
  instructions(preset?: TeachingPresetName): string;
  prepare(
    text: string,
    options?: {
      id?: string;
      preset?: TeachingPresetName;
      prompt?: string;
      final?: boolean;
      options?: RuntimeOptions;
    }
  ): PreparedAnswer;
  feedback(input: {type: string; preset?: TeachingPresetName; helpful: boolean}): void;
  readonly preferences: import('../policy/index.mjs').PreferenceStore;
  stats(): HostAdapterStats;
}
/** Instructions, lossless split, explicit feedback and shadow metrics for a chat host or agent. */
export function createHostAdapter(options?: HostAdapterOptions): HostAdapter;
export interface HostThemeColors {
  accent?: string;
  ink?: string;
  muted?: string;
  line?: string;
  paper?: string;
  soft?: string;
  font?: string;
}
/** Map a few host colours onto every --sw-* custom property. */
export function themeTokens(colors?: HostThemeColors): Record<string, string>;
