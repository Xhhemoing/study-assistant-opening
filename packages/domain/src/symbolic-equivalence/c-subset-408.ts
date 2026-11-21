export type C408Pointer = { objectId: number; generation: number; fieldOrIndex: string | number | null };
export type C408Value = number | string | boolean | C408Pointer | null;
export type C408Type = "int" | "bool" | "pointer" | "string";
export type C408Instruction =
  | { op: "const"; target: string; value: C408Value; type?: C408Type }
  | { op: "assign"; target: string; value: C408Operand; type?: C408Type }
  | { op: "binary"; target: string; operator: "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">="; left: C408Operand; right: C408Operand }
  | { op: "alloc"; target: string; fields?: Record<string, C408Value>; length?: number }
  | { op: "free"; pointer: C408Operand }
  | { op: "load"; target: string; pointer: C408Operand }
  | { op: "store"; pointer: C408Operand; value: C408Operand }
  | { op: "field"; target: string; pointer: C408Operand; field: string }
  | { op: "index"; target: string; pointer: C408Operand; index: C408Operand }
  | { op: "jump"; target: number }
  | { op: "branch"; condition: C408Operand; ifTrue: number; ifFalse: number }
  | { op: "return"; value?: C408Operand }
  | { op: "noop" };
export type C408Operand = C408Value | { variable: string };
export type C408Program = { instructions: readonly C408Instruction[]; initial?: Record<string, C408Value>; memoryBytes?: number };
export type StepTraceSnapshot = { pc: number; op: string; phase: "before" | "after"; variables: Record<string, C408Value>; heap: Record<string, unknown> };
export type C408FailureReason = "fuel_exhausted" | "memory_limit_exceeded" | "clock_budget_exceeded" | "null_dereference" | "wild_pointer" | "use_after_free" | "out_of_bounds" | "uninitialized_read" | "integer_overflow" | "type_error" | "invalid_instruction";
export type C408RunResult =
  | { status: "verified"; value: C408Value; steps: number; trace: StepTraceSnapshot[] }
  | { status: "unverified"; reason: C408FailureReason; detail?: string; at?: number; steps: number; trace: StepTraceSnapshot[] };

const MAX_INT = 2_147_483_647;
const MIN_INT = -2_147_483_648;
const DEFAULT_FUEL = 50_000;
const MEMORY_LIMIT = 8 * 1024 * 1024;

type HeapObject = { id: number; generation: number; live: boolean; fields: Map<string | number, C408Value>; initialized: Set<string | number>; length?: number };

function cloneValue(value: C408Value): C408Value { return value && typeof value === "object" ? { ...value } : value; }
function cloneVariables(values: Map<string, C408Value>): Record<string, C408Value> { return Object.fromEntries([...values.entries()].map(([key, value]) => [key, cloneValue(value)])); }
function isPointer(value: C408Value): value is C408Pointer { return typeof value === "object" && value !== null && typeof value.objectId === "number" && typeof value.generation === "number" && (typeof value.fieldOrIndex === "string" || typeof value.fieldOrIndex === "number" || value.fieldOrIndex === null); }

export function runCSubset408(program: C408Program, options: { fuel?: number; memoryLimitBytes?: number; clockBudgetMs?: number } = {}): C408RunResult {
  const fuel = options.fuel ?? DEFAULT_FUEL, memoryLimit = options.memoryLimitBytes ?? MEMORY_LIMIT, clockBudget = options.clockBudgetMs ?? 50;
  const vars = new Map<string, C408Value>(Object.entries(program.initial ?? {}).map(([key, value]) => [key, cloneValue(value)]));
  const heap = new Map<number, HeapObject>(); const trace: StepTraceSnapshot[] = []; let nextObjectId = 1; let pc = 0; let steps = 0; const started = Date.now();
  const failure = (reason: C408FailureReason, detail?: string): C408RunResult => ({ status: "unverified", reason, detail, at: pc, steps, trace });
  const memoryUsed = () => {
    const heapBytes = [...heap.values()].reduce((total, object) => total + 64 + object.fields.size * 32, 0);
    const traceBytes = trace.length * 256; const outputBytes = 0; const codeBytes = JSON.stringify(program).length;
    return heapBytes + traceBytes + outputBytes + codeBytes;
  };
  const snapshot = (instruction: C408Instruction, phase: "before" | "after"): StepTraceSnapshot => ({ pc, op: instruction.op, phase, variables: cloneVariables(vars), heap: Object.fromEntries([...heap.entries()].map(([id, object]) => [String(id), { generation: object.generation, live: object.live, fields: Object.fromEntries([...object.fields.entries()].map(([key, value]) => [String(key), cloneValue(value)])) }])) });
  const read = (operand: C408Operand): C408Value => typeof operand === "object" && operand !== null && "variable" in operand ? vars.get(operand.variable) ?? undefined as unknown as null : cloneValue(operand);
  const requirePointer = (value: C408Value): HeapObject | null => { if (!isPointer(value)) return null; const object = heap.get(value.objectId); if (!object) return null; if (!object.live || object.generation !== value.generation) return null; return object; };
  const checkInteger = (value: number): C408RunResult | null => Number.isInteger(value) && value >= MIN_INT && value <= MAX_INT ? null : failure("integer_overflow");
  const writeTarget = (target: string, value: C408Value): C408RunResult | null => { if (value === undefined) return failure("uninitialized_read"); vars.set(target, cloneValue(value)); return null; };

  while (pc >= 0 && pc < program.instructions.length) {
    if (steps >= fuel) return failure("fuel_exhausted");
    if (Date.now() - started > clockBudget) return failure("clock_budget_exceeded");
    if (memoryUsed() > memoryLimit) return failure("memory_limit_exceeded");
    const instruction = program.instructions[pc]!; trace.push(snapshot(instruction, "before")); steps++;
    let nextPc = pc + 1;
    try {
      switch (instruction.op) {
        case "const": { const error = writeTarget(instruction.target, instruction.value); if (error) return error; break; }
        case "assign": { const error = writeTarget(instruction.target, read(instruction.value)); if (error) return error; break; }
        case "binary": {
          const left = read(instruction.left), right = read(instruction.right); if (left === undefined || right === undefined) return failure("uninitialized_read");
          let value: C408Value;
          if (["+", "-", "*", "/", "%"].includes(instruction.operator)) {
            if (typeof left !== "number" || typeof right !== "number") return failure("type_error");
            if ((instruction.operator === "/" || instruction.operator === "%") && right === 0) return failure("type_error", "division_by_zero");
            value = instruction.operator === "+" ? left + right : instruction.operator === "-" ? left - right : instruction.operator === "*" ? left * right : instruction.operator === "/" ? Math.trunc(left / right) : left % right;
            const overflow = checkInteger(value as number); if (overflow) return overflow;
          } else { value = instruction.operator === "==" ? left === right : instruction.operator === "!=" ? left !== right : instruction.operator === "<" ? (left as number) < (right as number) : instruction.operator === "<=" ? (left as number) <= (right as number) : instruction.operator === ">" ? (left as number) > (right as number) : (left as number) >= (right as number); }
          const error = writeTarget(instruction.target, value); if (error) return error; break;
        }
        case "alloc": { const object: HeapObject = { id: nextObjectId, generation: 1, live: true, fields: new Map(), initialized: new Set(), length: instruction.length }; for (const [key, value] of Object.entries(instruction.fields ?? {})) { object.fields.set(key, cloneValue(value)); object.initialized.add(key); } if (instruction.length !== undefined) for (let i = 0; i < instruction.length; i++) object.fields.set(i, null); heap.set(nextObjectId, object); const error = writeTarget(instruction.target, { objectId: nextObjectId++, generation: object.generation, fieldOrIndex: null }); if (error) return error; break; }
        case "free": { const pointer = read(instruction.pointer); const object = requirePointer(pointer); if (!object) return isPointer(pointer) && heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer"); object.live = false; object.generation++; break; }
        case "load": { const pointer = read(instruction.pointer); if (pointer === null) return failure("null_dereference"); const object = requirePointer(pointer); if (!object) return isPointer(pointer) && heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer"); const key = isPointer(pointer) ? pointer.fieldOrIndex : null; if (key === null) return failure("type_error", "root_pointer_has_no_load_field"); if (typeof key === "number" && (object.length === undefined || key < 0 || key >= object.length)) return failure("out_of_bounds"); if (!object.initialized.has(key)) return failure("uninitialized_read"); const error = writeTarget(instruction.target, object.fields.get(key) ?? null); if (error) return error; break; }
        case "store": { const pointer = read(instruction.pointer), value = read(instruction.value); if (pointer === null) return failure("null_dereference"); const object = requirePointer(pointer); if (!object) return isPointer(pointer) && heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer"); const key = isPointer(pointer) ? pointer.fieldOrIndex : null; if (key === null) return failure("type_error", "root_pointer_has_no_store_field"); if (typeof key === "number" && (object.length === undefined || key < 0 || key >= object.length)) return failure("out_of_bounds"); object.fields.set(key, cloneValue(value)); object.initialized.add(key); break; }
        case "field": { const pointer = read(instruction.pointer); if (pointer === null) return failure("null_dereference"); const object = requirePointer(pointer); if (!object) return isPointer(pointer) && heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer"); if (!object.fields.has(instruction.field)) return failure("uninitialized_read"); const error = writeTarget(instruction.target, { objectId: object.id, generation: object.generation, fieldOrIndex: instruction.field }); if (error) return error; break; }
        case "index": { const pointer = read(instruction.pointer), index = read(instruction.index); if (pointer === null) return failure("null_dereference"); if (typeof index !== "number" || !Number.isInteger(index)) return failure("type_error"); const object = requirePointer(pointer); if (!object) return isPointer(pointer) && heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer"); if (object.length === undefined || index < 0 || index >= object.length) return failure("out_of_bounds"); const error = writeTarget(instruction.target, { objectId: object.id, generation: object.generation, fieldOrIndex: index }); if (error) return error; break; }
        case "jump": if (!Number.isInteger(instruction.target) || instruction.target < 0 || instruction.target >= program.instructions.length) return failure("invalid_instruction"); else nextPc = instruction.target; break;
        case "branch": { const condition = read(instruction.condition); if (typeof condition !== "boolean") return failure("type_error"); nextPc = condition ? instruction.ifTrue : instruction.ifFalse; break; }
        case "return": { const value = instruction.value === undefined ? null : read(instruction.value); if (value === undefined) return failure("uninitialized_read"); trace.push(snapshot(instruction, "after")); return { status: "verified", value, steps, trace }; }
        case "noop": break;
        default: return failure("invalid_instruction");
      }
    } catch (error) { return failure("type_error", error instanceof Error ? error.message : "interpreter_error"); }
    trace.push(snapshot(instruction, "after")); pc = nextPc;
  }
  return { status: "verified", value: null, steps, trace };
}
export const executeCSubset408 = runCSubset408;
export const run408Program = runCSubset408;
export const verifyCSubset408 = runCSubset408;
