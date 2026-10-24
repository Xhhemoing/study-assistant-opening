import type {SenseWeave, Interaction} from '../element/sense-weave.mjs';
import type {RuntimeOptions, SessionOptions, OutputSession, OutputEnvelope} from '../runtime/index.mjs';
import type {ChatMessage} from '../core/adapters.mjs';
import type {Source} from '../core/document.mjs';
export interface MountOptions extends RuntimeOptions {theme?: 'light' | 'dark' | 'auto'; chrome?: 'full' | 'none'; renderInline?: import('../element/sense-weave.mjs').InlineRenderer; onInteraction?: (event: Interaction) => void; showDecision?:boolean; onDecision?:(decision:import('../policy/index.mjs').PresentationDecision)=>void;/** Observer failures are reported without interrupting rendering. */onError?:(error:unknown)=>void}
export interface SenseWeaveMount {element: SenseWeave; render(message: ChatMessage, options?:RuntimeOptions): OutputEnvelope; setContext(context:import('../policy/index.mjs').PresentationContext):void; resetPreferences():void; getStats():{cacheHits:number;cacheMisses:number;cacheEntries:number;cacheChars:number;extraModelCalls:number}; stream(options?: SessionOptions): OutputSession; setSources(sources: Source[]): void; unmount(): void}
export function mountSenseWeave(container: HTMLElement, options?: MountOptions): Promise<SenseWeaveMount>;
export interface BlockMountOptions {theme?: 'light' | 'dark' | 'auto'; /** Host brand colours mapped onto every --sw-* token. */ tokens?: import('../runtime/host.mjs').HostThemeColors; sources?: Source[]; renderInline?: import('../element/sense-weave.mjs').InlineRenderer; onInteraction?: (event: Interaction) => void; onError?: (error: unknown) => void}
export interface SenseWeaveBlockMount {element: SenseWeave; update(segment: import('../runtime/host.mjs').BlockSegment): void; unmount(): void}
export function mountBlock(container: HTMLElement, segment: import('../runtime/host.mjs').BlockSegment, options?: BlockMountOptions): Promise<SenseWeaveBlockMount>;
