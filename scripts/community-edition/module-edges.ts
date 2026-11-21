import ts from "typescript";

export type ResolutionMode = "import" | "require";
export type ModuleEdge = { spec: string; line: number; kind: "module" | "type" | "path" | "ambient"; mode: ResolutionMode };
type Loader = "require" | "module" | "wrapper";
const bundler = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function member(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const key = unwrap(node.argumentExpression);
  if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return key.text;
  return undefined;
}

function usesWrapperArguments(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) && !ts.isArrowFunction(parent)) return false;
  }
  return true;
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) && parent.propertyName === node) return true;
  return (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)
    || ts.isMethodSignature(parent) || ts.isPropertyAccessExpression(parent)) && parent.name === node;
}

export function readModuleEdges(file: string, text: string): ModuleEdge[] {
  const fileMode: ResolutionMode = /\.c[jt]s$/u.test(file) ? "require" : "import";
  const source = ts.createSourceFile(file, text, {
    languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseAll,
    impliedNodeFormat: fileMode === "require" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
  }, true);
  const nodes: ts.Node[] = [];
  const seen = new Set<ts.Node>();
  const edges: ModuleEdge[] = [];
  const literals = new Set<number>();
  const handled = new Set<ts.Node>();
  const aliases = new Map<string, Loader>();
  const lineAt = (offset: number) => source.getLineAndCharacterOfPosition(offset).line + 1;
  const fail = (node: ts.Node, message: string): never => { throw new Error(`${file}:${lineAt(node.getStart(source))}: ${message}`); };
  const syntax = (source as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics[0];
  if (syntax) throw new Error(`${file}:${lineAt(syntax.start)}: ${ts.flattenDiagnosticMessageText(syntax.messageText, "\n")}`);

  const visit = (node: ts.Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    nodes.push(node);
    ts.forEachChild(node, visit);
    ts.getJSDocCommentsAndTags(node).forEach(visit);
  };
  visit(source);

  const edge = (node: ts.Node | undefined, origin: ts.Node, kind: ModuleEdge["kind"], mode?: ResolutionMode): void => {
    const spec = node && ts.isExpression(node) ? unwrap(node) : node;
    if (!spec || !ts.isStringLiteralLike(spec)) return fail(origin, "Nonliteral module specifier");
    const offset = spec.getStart(source);
    literals.add(offset);
    const typeMode = kind === "type" ? ts.getModeForUsageLocation(source, spec, bundler) : undefined;
    const resolution = mode ?? (typeMode === undefined ? fileMode : typeMode === ts.ModuleKind.CommonJS ? "require" : "import");
    edges.push({ spec: spec.text, line: lineAt(offset), kind, mode: resolution });
  };

  function loader(expression: ts.Expression, mark = false): Loader | undefined {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const binding = aliases.get(node.text) ?? (node.text === "require" || node.text === "module" ? node.text
        : node.text === "arguments" && usesWrapperArguments(node) ? "wrapper" : undefined);
      if (binding && mark) handled.add(node);
      return binding;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = loader(node.expression);
      const name = member(node);
      let binding: Loader | undefined;
      if (base === "module" && name === "require") binding = "require";
      if (base === "wrapper" && ts.isElementAccessExpression(node)) {
        if (name === "1") binding = "require";
        if (name === "2") binding = "module";
      }
      if (binding && mark) {
        handled.add(node);
        loader(node.expression, true);
      }
      return binding;
    }
    return undefined;
  }

  // Propagate direct aliases. Any write, escape or indirection that cannot be
  // represented by one of these bindings is a boundary violation below.
  const declarations = nodes.filter(ts.isVariableDeclaration);
  let progress = true;
  while (progress) {
    progress = false;
    for (const declaration of declarations) {
      if (!declaration.initializer || handled.has(declaration.name)) continue;
      const binding = loader(declaration.initializer);
      if (!binding) continue;
      if (ts.isIdentifier(declaration.name)) {
        const name = declaration.name.text;
        if (aliases.has(name) || ["module", "require", "arguments"].includes(name)) fail(declaration, "Ambiguous loader alias");
        aliases.set(name, binding);
      } else if (ts.isObjectBindingPattern(declaration.name) && binding === "module") {
        for (const element of declaration.name.elements) {
          const key = element.propertyName ?? element.name;
          if (!ts.isIdentifier(element.name) || !(ts.isIdentifier(key) || ts.isStringLiteral(key))
            || key.text !== "require" || element.dotDotDotToken || element.initializer
            || aliases.has(element.name.text) || ["require", "module", "arguments"].includes(element.name.text)) {
            fail(element, "Unsupported CommonJS module destructuring");
          }
          aliases.set(element.name.getText(source), "require");
          handled.add(element.name);
          handled.add(key);
        }
      } else fail(declaration, "Unsupported loader binding pattern");
      handled.add(declaration.name);
      loader(declaration.initializer, true);
      progress = true;
    }
  }

  for (const node of nodes) {
    if (ts.isImportDeclaration(node)) edge(node.moduleSpecifier, node, node.importClause?.isTypeOnly ? "type" : "module");
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) edge(node.moduleSpecifier, node, node.isTypeOnly ? "type" : "module");
    if (ts.isExternalModuleReference(node)) {
      const typeOnly = ts.isImportEqualsDeclaration(node.parent) && node.parent.isTypeOnly;
      edge(node.expression, node, typeOnly ? "type" : "module", "require");
    }
    if (ts.isImportTypeNode(node)) edge(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, node, "type");
    if (ts.isJSDocImportTag(node)) edge(node.moduleSpecifier, node, "type");
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) edge(node.arguments[0], node, "module", "import");
      else if (loader(node.expression) === "require") {
        loader(node.expression, true);
        edge(node.arguments[0], node, "module", "require");
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && loader(node.expression) === "module" && member(node) === "exports") {
      loader(node.expression, true);
      handled.add(node);
    }
  }

  for (const node of nodes) {
    if (handled.has(node)) continue;
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      const name = node.text;
      if (/^(?:SkillBeliefV1|SeededRecipe|TutorGraph)$/iu.test(name)) fail(node, `Closed-core symbol ${name}`);
      if (aliases.has(name) || name === "createRequire" || name === "eval" || name === "Function"
        || name === "require" || name === "module" || (name === "arguments" && usesWrapperArguments(node))) {
        fail(node, `Unresolved or escaping loader ${name}`);
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = member(node);
      if (name === "require" || name === "createRequire" || name === "getBuiltinModule") fail(node, `Unresolved loader member ${name}`);
    }
  }

  const addReferences = (references: readonly ts.FileReference[], kind: ModuleEdge["kind"]) => {
    for (const ref of references) edges.push({ spec: ref.fileName, line: lineAt(ref.pos), kind, mode: fileMode });
  };
  addReferences(source.referencedFiles, "path");
  addReferences(source.typeReferenceDirectives, "ambient");

  // TypeScript omits some inline or malformed import types from its JSDoc AST.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, source.languageVariant, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.MultiLineCommentTrivia && token !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const comment = scanner.getTokenText();
    for (const pragma of comment.matchAll(/@jsxImportSource\s+(\S+?)(?=\s|\*\/|$)/gu)) {
      edges.push({ spec: `${pragma[1]}/jsx-runtime`, line: lineAt(scanner.getTokenStart() + pragma.index), kind: "module", mode: fileMode });
    }
    if (!comment.startsWith("/**")) continue;
    for (const match of comment.matchAll(/\bimport\s*\(/gu)) {
      const offset = scanner.getTokenStart() + match.index;
      const tail = comment.slice(match.index + match[0].length).replace(/(\r?\n[ \t]*)\*/gu, "$1 ");
      const specScanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, tail);
      const first = specScanner.scan();
      if (first !== ts.SyntaxKind.StringLiteral && first !== ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
        throw new Error(`${file}:${lineAt(offset)}: Nonliteral JSDoc module specifier`);
      }
      if (literals.has(offset + match[0].length + specScanner.getTokenStart())) continue;
      const spec = specScanner.getTokenValue();
      const close = specScanner.scan();
      if (close !== ts.SyntaxKind.CloseParenToken && close !== ts.SyntaxKind.CommaToken) {
        throw new Error(`${file}:${lineAt(offset)}: Malformed JSDoc module specifier`);
      }
      edges.push({ spec, line: lineAt(offset), kind: "type", mode: fileMode });
    }
  }
  return edges;
}
