import { z } from "zod";

export const propertyValueTypeSchema = z.enum(["string", "number", "boolean", "json"]);

export const readOnlyPropertySchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1),
  valueType: propertyValueTypeSchema,
  value: z.unknown().refine((value) => value !== undefined, {
    message: "Property value is required",
  }),
  updatedAt: z.string().datetime(),
});

export const blockPropertyGroupSchema = z.object({
  blockId: z.string().uuid(),
  blockType: z.string().min(1),
  text: z.string().nullable(),
  properties: z.array(readOnlyPropertySchema),
});

export const documentPropertiesResponseSchema = z.object({
  document: z.array(readOnlyPropertySchema),
  blocks: z.array(blockPropertyGroupSchema),
});

export type ReadOnlyProperty = z.infer<typeof readOnlyPropertySchema>;
export type BlockPropertyGroup = z.infer<typeof blockPropertyGroupSchema>;
export type DocumentPropertiesResponse = z.infer<typeof documentPropertiesResponseSchema>;
