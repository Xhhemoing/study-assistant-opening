/** PR-H: render both env templates from ENV_REGISTRY (single definition). */
import { ENV_GROUPS, ENV_REGISTRY } from "./registry";

export type EnvTemplateTarget = "dev" | "docker";

export const ENV_TEMPLATE_FILES: Record<EnvTemplateTarget, string> = {
  dev: ".env.example",
  docker: "infra/docker/opening.env.example",
};

const HEADERS: Record<EnvTemplateTarget, string[]> = {
  dev: [
    "# GENERATED from packages/config/src/registry.ts. Do not edit by hand:",
    "#   npx tsx scripts/env-examples.ts --write   (CI: --check)",
    "# Local development template. Copy to .env; never commit a real .env or token.",
    "# No NEXT_PUBLIC_* variables: switches are server-side and the UI reads",
    "# GET /api/opening/capabilities (NEXT_PUBLIC_* would be inlined at build).",
  ],
  docker: [
    "# GENERATED from packages/config/src/registry.ts. Do not edit by hand:",
    "#   npx tsx scripts/env-examples.ts --write   (CI: --check)",
    "# Compose/production template for infra/docker/compose.opening.yml.",
    "# Copy to infra/docker/opening.env and replace every REPLACE_ME value.",
    "# Server switches only; one image serves every environment (no build args).",
  ],
};

export function renderEnvTemplate(target: EnvTemplateTarget): string {
  const lines = [...HEADERS[target]];
  for (const group of ENV_GROUPS) {
    const specs = ENV_REGISTRY.filter((spec) => spec.group === group.id && spec[target]);
    if (!specs.length) continue;
    lines.push("", `# --- ${group.title} ---`);
    for (const spec of specs) {
      const line = spec[target]!;
      const flags = [spec.kind, spec.secret ? "secret" : null, spec.required ? `required:${spec.required}` : null].filter(Boolean).join(", ");
      lines.push(`# ${spec.doc} [${flags}]`);
      lines.push(`${line.commented ? "# " : ""}${spec.name}=${line.value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
