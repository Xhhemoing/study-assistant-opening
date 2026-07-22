import { z } from "zod";

export const registerRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(120),
});

export const loginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const authUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  workspaceId: z.string().uuid(),
});

export const authErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "UNAUTHENTICATED",
      "WORKSPACE_FORBIDDEN",
      "NOT_FOUND",
      "VALIDATION",
      "CONFLICT",
      "INVALID_CREDENTIALS",
    ]),
    message: z.string().min(1),
  }),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthErrorBody = z.infer<typeof authErrorSchema>;
