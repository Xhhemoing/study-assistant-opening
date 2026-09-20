import { z } from "zod";

export const openingModelFields = {
  OPENING_MODEL_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENING_MODEL_API_KEY: z.string().default(""),
  OPENING_MODEL_NAME: z.string().min(1).default("gpt-4o-mini"),
  OPENING_MODEL_DAILY_CAP_CENTS: z.coerce.number().int().nonnegative().max(2_147_483_647).default(0),
  OPENING_MODEL_INPUT_CENTS_PER_MILLION: z.coerce.number().finite().nonnegative().default(0),
  OPENING_MODEL_OUTPUT_CENTS_PER_MILLION: z.coerce.number().finite().nonnegative().default(0),
};

export const openingModelSchema = z.object(openingModelFields).superRefine((value, ctx) => {
  if (value.OPENING_MODEL_API_KEY && value.OPENING_MODEL_DAILY_CAP_CENTS > 0) {
    for (const key of ["OPENING_MODEL_INPUT_CENTS_PER_MILLION", "OPENING_MODEL_OUTPUT_CENTS_PER_MILLION"] as const) {
      if (value[key] <= 0) ctx.addIssue({ code: "custom", path: [key], message: "enabled model requires positive configured pricing" });
    }
  }
});

export function loadOpeningModel(source: NodeJS.ProcessEnv = process.env) {
  const value = openingModelSchema.parse(source);
  return {
    baseUrl: value.OPENING_MODEL_BASE_URL, apiKey: value.OPENING_MODEL_API_KEY,
    name: value.OPENING_MODEL_NAME, dailyCapCents: value.OPENING_MODEL_DAILY_CAP_CENTS,
    inputCentsPerMillion: value.OPENING_MODEL_INPUT_CENTS_PER_MILLION,
    outputCentsPerMillion: value.OPENING_MODEL_OUTPUT_CENTS_PER_MILLION,
  };
}

const openingTutorFields = {
  OPENING_TUTOR_MAX_CONTEXT_CHARS: z.coerce.number().finite().int().positive().max(100_000).default(12_000),
  OPENING_TUTOR_RESERVED_CENTS: z.coerce.number().finite().int().positive().max(2_147_483_647).default(100),
  OPENING_TUTOR_MAX_OUTPUT_TOKENS: z.coerce.number().finite().int().positive().max(100_000).default(2_048),
};

const openingTutorSchema = z.object(openingTutorFields);

/** Finite positive OPENING_TUTOR_* knobs used by the worker tutor handler. */
export function loadOpeningTutorConfig(source: NodeJS.ProcessEnv = process.env) {
  const value = openingTutorSchema.parse(source);
  return {
    maxContextCharacters: value.OPENING_TUTOR_MAX_CONTEXT_CHARS,
    reservedCents: value.OPENING_TUTOR_RESERVED_CENTS,
    maxOutputTokens: value.OPENING_TUTOR_MAX_OUTPUT_TOKENS,
  };
}

