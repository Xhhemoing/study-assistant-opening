import type {PresentationDocument, Source, BlockData} from '../core/document.mjs';
export interface Capabilities {schemaVersions: string[]; components: string[]; rich: boolean; maxInteractiveBlocks: number}
export type CapabilityInput = Partial<Capabilities>;
export const RUNTIME_VERSION: '0.5.0-rc.1';
export const DEFAULT_CAPABILITIES: Readonly<{schemaVersions: readonly string[]; components: readonly (keyof BlockData)[]; rich: boolean; maxInteractiveBlocks: number}>;
export function negotiateCapabilities(input?: CapabilityInput): Capabilities;
export function applyCapabilities(input: PresentationDocument, capabilities?: CapabilityInput, sources?: Source[], options?: {partial?: boolean}): {document: PresentationDocument; downgraded: number};
