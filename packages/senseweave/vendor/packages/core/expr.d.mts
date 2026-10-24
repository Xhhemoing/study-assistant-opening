export type ExprNode = Record<string, unknown>;
export function compileExpr(src: string): {ast: ExprNode; names: Set<string>};
export function evaluateExpr(
  ast: ExprNode,
  scope: Record<string, number> | Map<string, number>
): number;
export function evaluate(src: string, scope?: Record<string, number> | Map<string, number>): number;
