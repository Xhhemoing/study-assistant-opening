#!/usr/bin/env node
/**
 * Server data-access boundary gate (plan §7.4).
 *
 * Builds the module graph of apps/web starting from every Client Component
 * ("use client" files) and fails if any *runtime* edge (static import,
 * re-export, dynamic import(), require) reaches a server-only target, directly
 * or transitively. Type-only imports/exports are erased by the compiler and
 * are ignored. Classification is by module content/graph, never by filename.
 *
 * Server-only targets:
 *  - bare packages: @aistudy/database, postgres, drizzle-orm, ioredis,
 *    @aws-sdk/*, jose, server-only, node builtins
 *  - any web module that imports "server-only" (the Web server adapter marker)
 *
 * Usage: node scripts/check-server-boundary.mjs [--inventory] [--json]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(root, process.env.BOUNDARY_WEB_ROOT ?? "apps/web");
const srcRoot = path.join(webRoot, "src");

const SERVER_PACKAGES = [
  /^@aistudy\/database(\/|$)/,
  /^postgres$/,
  /^drizzle-orm(\/|$)/,
  /^ioredis$/,
  /^@aws-sdk\//,
  /^jose$/,
  /^server-only$/,
];
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
export function isServerPackage(spec) {
  return builtins.has(spec) || builtins.has(spec.split("/")[0]) || SERVER_PACKAGES.some((r) => r.test(spec));
}

const tsconfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(path.join(webRoot, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  webRoot,
);
const resolveCache = new Map();
function resolve(spec, from) {
  const key = `${from}\0${spec}`;
  if (!resolveCache.has(key)) {
    const r = ts.resolveModuleName(spec, from, tsconfig.options, ts.sys).resolvedModule;
    const f = r && !r.isExternalLibraryImport && !r.resolvedFileName.endsWith(".d.ts") ? path.resolve(r.resolvedFileName) : null;
    resolveCache.set(key, f);
  }
  return resolveCache.get(key);
}

/** @returns {{spec:string,line:number,kind:'runtime'|'type'|'reexport'|'dynamic'}[]} */
export function parseImports(file) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      const typeOnly = c && (c.isTypeOnly || (!c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) &&
        c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)));
      out.push({ spec: n.moduleSpecifier.text, line: line(n), kind: typeOnly ? "type" : "runtime" });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const typeOnly = n.isTypeOnly || (n.exportClause && ts.isNamedExports(n.exportClause) &&
        n.exportClause.elements.length > 0 && n.exportClause.elements.every((e) => e.isTypeOnly));
      out.push({ spec: n.moduleSpecifier.text, line: line(n), kind: typeOnly ? "type" : "reexport" });
    } else if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0]) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      out.push({ spec: n.arguments[0].text, line: line(n), kind: "dynamic" });
    } else if (ts.isImportTypeNode(n)) {
      return; // import("x").T in type position
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { imports: out, text };
}

const isClient = (text) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(text);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p, acc); }
    else if (/\.(tsx?|mjs|jsx?)$/.test(e) && !/\.(test|spec)\.tsx?$/.test(e)) acc.push(p);
  }
  return acc;
}

export function analyze() {
  const rel = (f) => path.relative(root, f);
  const info = new Map();
  const load = (f) => {
    if (!info.has(f)) {
      const { imports, text } = parseImports(f);
      info.set(f, { imports, client: isClient(text), serverMarked: imports.some((i) => i.spec === "server-only" && i.kind === "runtime") });
    }
    return info.get(f);
  };
  const files = walk(srcRoot);
  const inventory = { runtime: 0, type: 0, reexport: 0, dynamic: 0, clientFiles: 0, serverMarkedFiles: [] };
  for (const f of files) {
    const i = load(f);
    if (i.client) inventory.clientFiles++;
    if (i.serverMarked) inventory.serverMarkedFiles.push(rel(f));
    for (const imp of i.imports) inventory[imp.kind]++;
  }
  // DFS from each client file over runtime edges.
  const violations = [];
  const seenPair = new Set();
  for (const entry of files.filter((f) => load(f).client)) {
    const stack = [[entry, [`${rel(entry)}`]]];
    const visited = new Set([entry]);
    while (stack.length) {
      const [f, chain] = stack.pop();
      const fi = load(f);
      if (f !== entry && fi.serverMarked) {
        violations.push({ entry: rel(entry), target: `${rel(f)} (server-only)`, chain });
        continue;
      }
      for (const imp of fi.imports) {
        if (imp.kind === "type") continue;
        const hop = `${rel(f)}:${imp.line} -> ${imp.spec}${imp.kind === "runtime" ? "" : ` [${imp.kind}]`}`;
        if (isServerPackage(imp.spec)) {
          const k = `${entry}\0${hop}`;
          if (!seenPair.has(k)) { seenPair.add(k); violations.push({ entry: rel(entry), target: imp.spec, chain: [...chain.slice(0, -1), hop] }); }
          continue;
        }
        const next = resolve(imp.spec, f);
        if (!next || visited.has(next)) continue;
        visited.add(next);
        stack.push([next, [...chain.slice(0, -1), hop, rel(next)]]);
      }
    }
  }
  // Inventory only: type-only edges from client-reachable code into server
  // packages (DTO leaks that belong in @aistudy/contracts). Not a failure.
  const typeLeaks = [];
  for (const entry of files.filter((f) => load(f).client)) {
    const stack = [entry];
    const visited = new Set([entry]);
    while (stack.length) {
      const f = stack.pop();
      for (const imp of load(f).imports) {
        if (isServerPackage(imp.spec)) {
          if (imp.kind === "type") typeLeaks.push(`${rel(f)}:${imp.line} -> ${imp.spec}`);
          continue;
        }
        const next = resolve(imp.spec, f);
        if (next && !visited.has(next)) { visited.add(next); stack.push(next); }
      }
    }
  }
  inventory.clientTypeOnlyServerImports = [...new Set(typeLeaks)].sort();
  return { inventory, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { inventory, violations } = analyze();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ inventory, violations }, null, 2));
  } else {
    if (process.argv.includes("--inventory")) console.log(JSON.stringify(inventory, null, 2));
    for (const v of violations) console.error(`server-boundary: client ${v.entry} reaches ${v.target}\n    ${v.chain.join("\n    ")}`);
    console.log(`server-boundary: ${inventory.clientFiles} client entries, ${violations.length} violation(s)`);
  }
  process.exit(violations.length ? 1 : 0);
}
