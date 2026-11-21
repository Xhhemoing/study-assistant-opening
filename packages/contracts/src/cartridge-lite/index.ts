import { z } from "zod";

export const CARTRIDGE_LITE_VERSION = 1;
export const cartridgeLiteLevelSchema = z.enum(["L1", "L2"]);
export const cartridgeLiteCapabilitySchema = z.enum(["exact_text", "single_choice"]);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u);

export const cartridgeLiteCriterionSchema = z.strictObject({
  label: z.string().min(1).max(200),
  points: z.number().int().min(1).max(100),
});

const itemFields = { id: identifier, prompt: z.string().min(1).max(20_000), criterion: cartridgeLiteCriterionSchema };
const exactTextItem = z.strictObject({
  ...itemFields,
  kind: z.literal("exact_text"),
  accepted: z.array(z.string().min(1).max(10_000)).min(1).max(32),
  comparison: z.enum(["exact", "trim"]).default("exact"),
});
const singleChoiceItem = z.strictObject({
  ...itemFields,
  kind: z.literal("single_choice"),
  choices: z.array(z.strictObject({ id: identifier, label: z.string().min(1).max(2000) })).min(2).max(32),
  answerId: identifier,
});

export const cartridgeLiteItemSchema = z.discriminatedUnion("kind", [exactTextItem, singleChoiceItem]);

export const cartridgeLiteSchema = z.strictObject({
  version: z.literal(CARTRIDGE_LITE_VERSION),
  id: identifier,
  title: z.string().min(1).max(200),
  level: cartridgeLiteLevelSchema,
  capabilities: z.array(cartridgeLiteCapabilitySchema).max(2).optional(),
  items: z.array(cartridgeLiteItemSchema).min(1).max(1000),
}).superRefine((cartridge, context) => {
  const itemIds = new Set<string>();
  for (const [index, item] of cartridge.items.entries()) {
    if (itemIds.has(item.id)) {
      context.addIssue({ code: "custom", path: ["items", index, "id"], message: "Duplicate item ID" });
    }
    itemIds.add(item.id);
    if (item.kind === "single_choice") {
      const choices = new Set(item.choices.map(choice => choice.id));
      if (choices.size !== item.choices.length || !choices.has(item.answerId)) {
        context.addIssue({ code: "custom", path: ["items", index, "choices"], message: "Choices must be distinct and contain the answer ID" });
      }
    }
  }
});

export type CartridgeLite = z.infer<typeof cartridgeLiteSchema>;
export type CartridgeLiteItem = z.infer<typeof cartridgeLiteItemSchema>;
export type CartridgeLiteLevel = z.infer<typeof cartridgeLiteLevelSchema>;
export type CartridgeLiteValidation = { ok: true; cartridge: CartridgeLite }
  | { ok: false; code: "unsupported_level" | "unavailable" | "invalid_cartridge" };

const isAdvancedLevel = (level: unknown) => level === "L3" || level === "L4";

export function queryCartridgeLiteCapability(level: unknown, capability?: unknown): {
  status: "available" | "unsupported_level" | "unavailable";
} {
  if (isAdvancedLevel(level)) return { status: "unsupported_level" };
  if (!cartridgeLiteLevelSchema.safeParse(level).success
    || (capability !== undefined && !cartridgeLiteCapabilitySchema.safeParse(capability).success)) return { status: "unavailable" };
  return { status: "available" };
}

export function validateCartridgeLite(input: unknown): CartridgeLiteValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "invalid_cartridge" };
  const record = input as Record<string, unknown>;
  if (isAdvancedLevel(record.level) || (Array.isArray(record.items) && record.items.some((item: unknown) =>
    item !== null && typeof item === "object" && "level" in item && isAdvancedLevel(item.level)))) {
    return { ok: false, code: "unsupported_level" };
  }
  if (Object.keys(record).some(key => /^seeded[-_]?recipe$/iu.test(key))
    || (Array.isArray(record.capabilities) && record.capabilities.some(capability => !cartridgeLiteCapabilitySchema.safeParse(capability).success))) {
    return { ok: false, code: "unavailable" };
  }
  const result = cartridgeLiteSchema.safeParse(input);
  return result.success ? { ok: true, cartridge: result.data } : { ok: false, code: "invalid_cartridge" };
}
