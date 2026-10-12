/**
 * 纬 (weft) catalog: what a host can actually render. A planner — rules or a model —
 * sees `describe()`, never "you may generate any page".
 */
import { z } from "zod";
import { capabilityIdSchema } from "./artifact";

/** What the reader is trying to do; drives expression choice, not styling. */
export const COGNITIVE_TASKS = [
  "define",
  "structure",
  "process",
  "compare",
  "explore",
  "practice",
  "cite",
] as const;
export type CognitiveTask = (typeof COGNITIVE_TASKS)[number];

export const DISPLAY_MODES = ["text", "static", "interactive"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

export type Capability<P = unknown> = {
  /** `name@major`; a breaking params change bumps the major. */
  id: string;
  title: string;
  tasks: readonly CognitiveTask[];
  /** Must include "text": every capability degrades to readable prose. */
  modes: readonly DisplayMode[];
  params: z.ZodType<P>;
  /** Interpretation limits surfaced to planners and readers. */
  limits: readonly string[];
  /** Actions a block of this capability may request from its host. */
  actions?: readonly string[];
  /** Plain-text rendering used for text mode, exports, terminals and render failures. */
  toText(params: P): string;
};

export type CapabilityDescriptor = {
  id: string;
  title: string;
  tasks: CognitiveTask[];
  modes: DisplayMode[];
  limits: string[];
  actions: string[];
  paramsSchema: Record<string, unknown>;
};

export type CapabilityRegistry = {
  get(id: string): Capability | undefined;
  list(): Capability[];
  /** JSON-serializable catalog for model prompts, tool schemas and other agents. */
  describe(): CapabilityDescriptor[];
};

export class CapabilityRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRegistrationError";
  }
}

function assertWellFormed(capability: Capability, seen: Set<string>): void {
  if (!capabilityIdSchema.safeParse(capability.id).success) {
    throw new CapabilityRegistrationError(`invalid capability id "${capability.id}" (expected name@major)`);
  }
  if (seen.has(capability.id)) {
    throw new CapabilityRegistrationError(`duplicate capability id "${capability.id}"`);
  }
  if (!capability.modes.includes("text")) {
    throw new CapabilityRegistrationError(`capability "${capability.id}" must support text mode`);
  }
  if (capability.tasks.length === 0) {
    throw new CapabilityRegistrationError(`capability "${capability.id}" must declare at least one task`);
  }
}

export function createCapabilityRegistry(capabilities: readonly Capability[]): CapabilityRegistry {
  const byId = new Map<string, Capability>();
  for (const capability of capabilities) {
    assertWellFormed(capability, new Set(byId.keys()));
    byId.set(capability.id, capability);
  }
  return {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    describe: () =>
      [...byId.values()].map((capability) => ({
        id: capability.id,
        title: capability.title,
        tasks: [...capability.tasks],
        modes: [...capability.modes],
        limits: [...capability.limits],
        actions: [...(capability.actions ?? [])],
        // Input shape is what producers must emit; refinements without a JSON form become {}.
        paramsSchema: z.toJSONSchema(capability.params, { io: "input", unrepresentable: "any" }) as Record<
          string,
          unknown
        >,
      })),
  };
}

/** Typed helper so `toText` receives the parsed params type. */
export function defineCapability<P>(capability: Capability<P>): Capability {
  return capability as unknown as Capability;
}
