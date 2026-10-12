/**
 * PR-H: validate the full server configuration once at startup. An invalid
 * value (bad boolean, missing required value, broken dependency, NEXT_PUBLIC_*,
 * build digest mismatch) stops the server instead of failing on first request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { EnvValidationError, loadServerConfig } = await import("@aistudy/config");
  try {
    loadServerConfig(process.env, "web", { compiledBuildDigest: process.env.AISTUDY_BUILD_CONFIG_DIGEST });
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`[config] invalid server configuration:\n  - ${error.issues.join("\n  - ")}`);
    } else {
      console.error("[config] configuration check failed", error);
    }
    process.exit(1);
  }
}
