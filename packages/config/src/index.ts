export const DEFAULT_APP_NAME = "AIstudy" as const;

export function getNodeEnv(
  env: NodeJS.ProcessEnv = process.env,
): "development" | "test" | "production" {
  if (env.NODE_ENV === "production") return "production";
  if (env.NODE_ENV === "test") return "test";
  return "development";
}
