#!/usr/bin/env node
/**
 * Static client↔route contract check for apps/web.
 * - Every "/api/..." literal in client code (features, lib, app pages) must resolve to an
 *   app/api/** /route.ts, preferring static segments over [dynamic] ones.
 * - When the call site names an HTTP method (method: "POST", jsonInit("PUT"), …), the route must export it.
 * - Every internal page link ("/opening/…") must resolve to an app/** /page.tsx (route groups ignored).
 * Usage: node scripts/check-api-contracts.mjs [--json] [--strict]
 * Known limits: paths built by concatenation (`/api/opening/sources/${path}`) are matched by prefix only.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "apps/web/src");
const args = new Set(process.argv.slice(2));
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out); } else out.push(p);
  }
  return out;
};
const files = walk(src);
const segs = (p) => p.split("/").filter(Boolean);
const sourceSegments = (file) => path.relative(src, file).split(path.sep);
const isApiFile = (file) => {
  const [app, api] = sourceSegments(file);
  return app === "app" && api === "api";
};

const routes = files.filter(f => path.basename(f) === "route.ts" && isApiFile(f)).map(f => {
  const text = readFileSync(f, "utf8");
  const methods = new Set([...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1]));
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) for (const k of m[1].match(/\b(GET|POST|PUT|PATCH|DELETE)\b/g) ?? []) methods.add(k);
  const url = path.relative(path.join(src, "app"), path.dirname(f)).split(path.sep).join("/");
  return { url: `/${url}`, segs: segs(url), methods, file: path.relative(root, f) };
});
const pages = files.filter(f => path.basename(f) === "page.tsx" && sourceSegments(f)[0] === "app" && !isApiFile(f)).map(f => {
  const url = path.relative(path.join(src, "app"), path.dirname(f)).split(path.sep).filter(s => !/^\(.*\)$/.test(s)).join("/");
  return segs(url);
});

function bestRoute(pathSegs) {
  let best = null;
  for (const r of routes) {
    if (r.segs.length !== pathSegs.length) continue;
    let score = 0, ok = true, loose = false;
    r.segs.forEach((a, i) => {
      const b = pathSegs[i];
      if (a === b) score += 2;
      else if (a.startsWith("[")) score += b === "*" ? 1 : 0;
      else if (b !== "*") ok = false;
      else loose = true; // a dynamic client segment may target a static route (e.g. /api/auth/${mode})
    });
    if (ok && (!best || score > best.score)) best = { ...r, score, loose };
  }
  return best;
}
const pageExists = (pathSegs) => pages.some(p => {
  const last = p[p.length - 1] ?? "";
  if (last.startsWith("[[...")) { if (pathSegs.length < p.length - 1) return false; }
  else if (last.startsWith("[...")) { if (pathSegs.length < p.length) return false; }
  else if (p.length !== pathSegs.length) return false;
  return p.every((a, i) => a.startsWith("[") || a === pathSegs[i]);
});

const findings = [];
for (const f of files) {
  if (!/\.tsx?$/.test(f) || /\.(test|spec)\.tsx?$/.test(f) || isApiFile(f)) continue;
  const text = readFileSync(f, "utf8");
  const rel = path.relative(root, f);
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(/["'`](\/api\/[^"'`\s]*)/g)) {
    const raw = m[1];
    // `${x}` glued to a segment (`/memory${query}`) is a query suffix; a whole-segment `${x}` is dynamic.
    const normalized = raw.replace(/([^/])\$\{[^}]*\}/g, "$1").replace(/\$\{[^}]*\}/g, "*").split("?")[0].split("$")[0].replace(/\*+/g, "*");
    if (normalized.endsWith("/")) continue; // prefix concatenation, cannot resolve statically
    const route = bestRoute(segs(normalized));
    const window = text.slice(m.index, m.index + 400);
    const method = window.match(/method:\s*["'](GET|POST|PUT|PATCH|DELETE)/)?.[1] ?? window.match(/jsonInit\(\s*["'](\w+)/)?.[1];
    const prefixOnly = normalized.endsWith("/*") && routes.some(r => r.url.startsWith(normalized.slice(0, -1)));
    if (!route && prefixOnly) continue; // `${path}` may contain several segments
    if (!route) findings.push({ kind: "missing-route", file: rel, line: lineOf(m.index), url: raw });
    else if (method && !route.loose && !route.methods.has(method)) findings.push({ kind: "method-not-exported", file: rel, line: lineOf(m.index), url: raw, method, route: route.file, exported: [...route.methods] });
  }
  for (const m of text.matchAll(/(?:href=\{?|href:\s*|push\(|replace\(|redirect\()\s*["'`](\/opening\/[^"'`\s]*)/g)) {
    const raw = m[1];
    const normalized = raw.replace(/\$\{[^}]*\}/g, "x").split(/[?#]/)[0].split("$")[0];
    if (normalized.endsWith("/")) continue;
    if (!pageExists(segs(normalized))) findings.push({ kind: "missing-page", file: rel, line: lineOf(m.index), url: raw });
  }
}
if (args.has("--json")) console.log(JSON.stringify({ routes: routes.length, pages: pages.length, findings }, null, 1));
else {
  for (const x of findings) console.log(`${x.kind}\t${x.file}:${x.line}\t${x.method ?? ""} ${x.url}${x.exported ? `\t(exports ${x.exported.join(",")})` : ""}`);
  console.log(`\n${routes.length} routes, ${pages.length} pages, ${findings.length} findings`);
}
process.exit(args.has("--strict") && findings.length ? 1 : 0);
