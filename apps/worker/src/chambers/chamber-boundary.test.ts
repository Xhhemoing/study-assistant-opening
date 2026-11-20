import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { assertChamberAccess, ChamberSovereigntyViolationError, createLogisticsChamberDeps } from "./chamber-guard";
import type { LogisticsChamberDeps, TeachingChamberDeps } from "./chamber-ports";

const testFile = fileURLToPath(import.meta.url);
const chamberDir = dirname(testFile);

function checkPortTypes(logistics: LogisticsChamberDeps, teaching: TeachingChamberDeps) {
  // @ts-expect-error A teaching dependency bag cannot be widened into logistics.
  const leaked: LogisticsChamberDeps = { ...logistics, ...teaching };
  // @ts-expect-error Reserved assessment content is unavailable.
  logistics.reserved_retest_items("activity");
  // @ts-expect-error Hidden answers and canonical keys are unavailable.
  logistics.hidden_answer_blocks("item");
  // @ts-expect-error Formal observations are teaching writes.
  logistics.recordFormalObservation({} as Parameters<TeachingChamberDeps["recordFormalObservation"]>[0]);
  // @ts-expect-error Logistics cannot change mastery.
  logistics.mutateLearnerMastery("requirement", "observation");
  // @ts-expect-error Logistics cannot grade an attempt.
  logistics.gradeAssessmentAttempt("attempt");
  return leaked;
}

// Only chamber-local value dependencies are allowed, including barrel re-exports.
// Teaching adapters live at the composition root and arrive as scoped ports.
function outsideImports(file: string, source: string): string[] {
  const failures: string[] = [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function check(specifier: ts.Expression | undefined) {
    if (!specifier) return;
    if (ts.isStringLiteralLike(specifier) && specifier.text.startsWith(".")) {
      const path = relative(chamberDir, resolve(dirname(file), specifier.text));
      if (path && !path.startsWith(".." + sep) && path !== ".." && !/\.test(?:\.|$)/.test(path)) return;
    }
    failures.push(specifier.getText(tree));
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      // These two erased data contracts are the only external chamber dependencies.
      const allowedType = node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)
        && ["@aistudy/contracts", "../jobs/remind"].includes(node.moduleSpecifier.text);
      if (!allowedType) check(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      check(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      check(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return failures;
}

describe("chamber sovereignty", () => {
  it("checks forbidden calls with the TypeScript compiler", () => {
    // Worker typecheck excludes *.test.ts and Vitest normally just strips types.
    const program = ts.createProgram([testFile], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true,
      types: ["node"], noEmit: true,
    });
    const diagnostics = program.getSemanticDiagnostics(program.getSourceFile(testFile));
    expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
    expect(typeof checkPortTypes).toBe("function");
  });

  it("passes only the reminder operation and never reads or exposes leaked ports", async () => {
    const sendReminder = vi.fn(async () => ({ receiptId: "sent" }));
    const input = {
      sendReminder, futureSecret: vi.fn(), gradeAssessmentAttempt: vi.fn(),
      get hidden_answer_blocks(): never { throw new Error("private getter invoked"); },
    };
    const deps = createLogisticsChamberDeps(input);
    expect(Reflect.ownKeys(deps)).toEqual(["sendReminder"]);
    expect(Object.getPrototypeOf(deps)).toBeNull();
    expect(Object.isFrozen(deps)).toBe(true);
    const message = { recipientId: "owner", text: "due", idempotencyKey: "once" };
    const signal = new AbortController().signal;
    await expect(deps.sendReminder(message, signal)).resolves.toEqual({ receiptId: "sent" });
    expect(sendReminder).toHaveBeenCalledWith(message, signal);
  });

  it.each(["reserved_retest_items", "hidden_answer_blocks", "recordFormalObservation",
    "mutateLearnerMastery", "gradeAssessmentAttempt"])("rejects %s in logistics", port => {
    expect(() => assertChamberAccess("logistics", port)).toThrow(ChamberSovereigntyViolationError);
    expect(() => assertChamberAccess("teaching", port)).not.toThrow();
  });

  it("denies unknown and inherited port names", () => {
    for (const role of ["teaching", "logistics"] as const) {
      for (const port of ["futureSecret", "toString", "__proto__"]) {
        expect(() => assertChamberAccess(role, port)).toThrow(ChamberSovereigntyViolationError);
      }
    }
    expect(() => assertChamberAccess("logistics", "sendReminder")).not.toThrow();
  });

  it("keeps repository imports out of logistics and its chamber-local dependencies", () => {
    const files = (readdirSync(chamberDir, { recursive: true, encoding: "utf8" }) as string[])
      .filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/\.test\.[cm]?[jt]sx?$/.test(file));
    expect(files).toContain("chamber-guard.ts");
    expect(files.flatMap(file => outsideImports(resolve(chamberDir, file),
      readFileSync(resolve(chamberDir, file), "utf8")).map(entry => [file, entry]))).toEqual([]);
  });

  it.each([
    'import { readOpeningReservedKey as read } from "@aistudy/database";',
    'export * from "../../../../packages/database/src/repositories/opening-course-reserved-selection";',
    'import("../jobs/grade-observation")', 'require("@aistudy/database")', 'import(repoName)',
  ])("detects a forbidden dependency: %s", source => {
    expect(outsideImports(resolve(chamberDir, "logistics.ts"), source)).toHaveLength(1);
  });
});
