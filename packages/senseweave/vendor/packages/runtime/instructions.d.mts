import type {CapabilityInput} from './capabilities.mjs';
export type PresentationIntent = 'text' | 'explain' | 'compare' | 'plan' | 'calculate' | 'hint' | 'review';
export interface InstructionContext {maxChars?: number;intent?: PresentationIntent; prompt?: string; capabilities?: CapabilityInput}
export function selectPresentation(context?: InstructionContext): {template: PresentationIntent; reason: string; components: string[]};
export function createInstructions(context?: InstructionContext): string;
