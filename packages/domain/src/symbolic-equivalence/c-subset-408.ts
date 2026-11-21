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
export type C408Program = { instructions: readonly C408Instruction[]; initial?: Record<string, C408Value>; memoryBytes?: number; stepLimit?: number };
export type StepTraceSnapshot = { pc: number; op: string; phase: "before" | "after"; variables: Record<string, C408Value>; heap: Record<string, unknown> };
export type C408FailureReason =
  | "fuel_exhausted"
  | "memory_limit_exceeded"
  | "clock_budget_exceeded"
  | "null_dereference"
  | "wild_pointer"
  | "use_after_free"
  | "out_of_bounds"
  | "uninitialized_read"
  | "integer_overflow"
  | "type_error"
  | "invalid_jump_target"
  | "invalid_instruction";
export type C408RunResult =
  | { status: "verified"; value: C408Value; steps: number; trace: StepTraceSnapshot[] }
  | { status: "unverified"; reason: C408FailureReason; detail?: string; at?: number; steps: number; trace: StepTraceSnapshot[] };

const MAX_INT = 2_147_483_647;
const MIN_INT = -2_147_483_648;
const DEFAULT_FUEL = 50_000;
const MAX_MEMORY_BYTES = 8 * 1024 * 1024;
const MAX_TRACE_SNAPSHOTS = 512;
const TRACE_ENTRY_BYTES = 256;
const VAR_ENTRY_BYTES = 32;
const HEAP_HEADER_BYTES = 64;
const HEAP_TOMBSTONE_BYTES = 16;
const HEAP_SLOT_BYTES = 32;

type HeapObject = {
  id: number;
  generation: number;
  live: boolean;
  fields: Map<string | number, C408Value>;
  initialized: Set<string | number>;
  length?: number;
  slotCount: number;
};

function normalizeNumeric(value: C408Value): C408Value {
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  return value;
}

function cloneValue(value: C408Value): C408Value {
  return value && typeof value === "object" ? { ...value } : normalizeNumeric(value);
}

function cloneVariables(values: Map<string, C408Value>): Record<string, C408Value> {
  return Object.fromEntries([...values.entries()].map(([key, value]) => [key, cloneValue(value)]));
}

function isPointer(value: unknown): value is C408Pointer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as C408Pointer).objectId === "number" &&
    typeof (value as C408Pointer).generation === "number" &&
    (typeof (value as C408Pointer).fieldOrIndex === "string" ||
      typeof (value as C408Pointer).fieldOrIndex === "number" ||
      (value as C408Pointer).fieldOrIndex === null)
  );
}

function isVariableRef(operand: unknown): operand is { variable: string } {
  return typeof operand === "object" && operand !== null && "variable" in operand && typeof (operand as { variable: unknown }).variable === "string";
}

function isValidTarget(target: unknown, length: number): target is number {
  return typeof target === "number" && Number.isInteger(target) && target >= 0 && target < length;
}

function pointersEqual(left: C408Pointer, right: C408Pointer): boolean {
  return left.objectId === right.objectId && left.generation === right.generation && left.fieldOrIndex === right.fieldOrIndex;
}

function compareEquality(left: C408Value, right: C408Value): { ok: true; equal: boolean } | { ok: false } {
  if (left === null && right === null) return { ok: true, equal: true };
  if (left === null && isPointer(right)) return { ok: true, equal: false };
  if (isPointer(left) && right === null) return { ok: true, equal: false };
  if (isPointer(left) && isPointer(right)) return { ok: true, equal: pointersEqual(left, right) };
  if (typeof left === typeof right && !isPointer(left) && left !== null && right !== null) {
    return { ok: true, equal: left === right };
  }
  return { ok: false };
}

function estimateValueBytes(value: C408Value): number {
  if (typeof value === "string") return 16 + value.length * 2;
  if (isPointer(value)) {
    return 48 + (typeof value.fieldOrIndex === "string" ? value.fieldOrIndex.length * 2 : 0);
  }
  return 8;
}

function estimateCodeBytes(program: C408Program): number {
  try {
    return JSON.stringify(program.instructions).length;
  } catch {
    return program.instructions.length * 64;
  }
}

export function runCSubset408(program: C408Program, options: { fuel?: number; memoryLimitBytes?: number; clockBudgetMs?: number } = {}): C408RunResult {
  const requestedFuel = Math.min(program.stepLimit ?? DEFAULT_FUEL, options.fuel ?? DEFAULT_FUEL, DEFAULT_FUEL);
  const fuel = Number.isSafeInteger(requestedFuel) && requestedFuel >= 0 ? requestedFuel : 0;

  const rawMem = Math.min(program.memoryBytes ?? MAX_MEMORY_BYTES, options.memoryLimitBytes ?? MAX_MEMORY_BYTES, MAX_MEMORY_BYTES);
  const memoryLimit = Number.isFinite(rawMem) && rawMem >= 0 ? rawMem : 0;

  const vars = new Map<string, C408Value>();
  for (const [key, value] of Object.entries(program.initial ?? {})) {
    if (value !== undefined) vars.set(key, cloneValue(value));
  }

  const heap = new Map<number, HeapObject>();
  const trace: StepTraceSnapshot[] = [];
  let nextObjectId = 1;
  let pc = 0;
  let steps = 0;

  const codeBytes = estimateCodeBytes(program);
  let heapBytes = 0;
  let varBytes = [...vars.entries()].reduce(
    (sum, [key, value]) => sum + VAR_ENTRY_BYTES + key.length * 2 + (typeof value === "string" ? value.length * 2 : 0),
    0,
  );
  let traceBytes = 0;
  const totalMemoryBytes = () => codeBytes + heapBytes + varBytes + traceBytes;

  const estimateSnapshotBytes = (): number => {
    let bytes = TRACE_ENTRY_BYTES;
    for (const [key, value] of vars) {
      bytes += VAR_ENTRY_BYTES + key.length * 2 + estimateValueBytes(value);
    }
    for (const object of heap.values()) {
      bytes += HEAP_HEADER_BYTES + object.fields.size * HEAP_SLOT_BYTES;
      for (const [fieldKey, fieldValue] of object.fields) {
        bytes += (typeof fieldKey === "string" ? fieldKey.length * 2 : 0) + estimateValueBytes(fieldValue);
      }
    }
    return bytes;
  };

  const snapshot = (instruction: C408Instruction, phase: "before" | "after"): StepTraceSnapshot => ({
    pc,
    op: instruction.op,
    phase,
    variables: cloneVariables(vars),
    heap: Object.fromEntries(
      [...heap.entries()].map(([id, object]) => [
        String(id),
        {
          generation: object.generation,
          live: object.live,
          fields: Object.fromEntries([...object.fields.entries()].map(([key, value]) => [String(key), cloneValue(value)])),
        },
      ]),
    ),
  });

  const pushTrace = (instruction: C408Instruction, phase: "before" | "after"): C408RunResult | null => {
    if (trace.length >= MAX_TRACE_SNAPSHOTS) return null;
    const snapBytes = estimateSnapshotBytes();
    if (totalMemoryBytes() + snapBytes > memoryLimit) {
      return failure("memory_limit_exceeded", "trace_memory_limit_exceeded");
    }
    trace.push(snapshot(instruction, phase));
    traceBytes += snapBytes;
    return null;
  };

  const failure = (reason: C408FailureReason, detail?: string): C408RunResult => ({
    status: "unverified",
    reason,
    detail,
    at: pc,
    steps,
    trace,
  });

  const read = (operand: C408Operand): C408Value | undefined => {
    if (isVariableRef(operand)) {
      if (!vars.has(operand.variable)) return undefined;
      const stored = vars.get(operand.variable);
      return stored === undefined ? undefined : cloneValue(stored);
    }
    if (typeof operand === "object" && operand !== null && !isPointer(operand)) return undefined;
    return operand === undefined ? undefined : cloneValue(operand);
  };

  const requirePointer = (value: C408Value): HeapObject | null => {
    if (!isPointer(value)) return null;
    const object = heap.get(value.objectId);
    if (!object || !object.live || object.generation !== value.generation) return null;
    return object;
  };

  const checkInteger = (value: number): { ok: true; value: number } | { ok: false; failure: C408RunResult } => {
    if (!Number.isInteger(value) || value < MIN_INT || value > MAX_INT) {
      return { ok: false, failure: failure("integer_overflow") };
    }
    return { ok: true, value: value === 0 ? 0 : value };
  };

  const writeTarget = (target: string, value: C408Value | undefined): C408RunResult | null => {
    if (value === undefined) return failure("uninitialized_read");
    const isNew = !vars.has(target);
    const prevValue = vars.get(target);
    const prevStringBytes = typeof prevValue === "string" ? prevValue.length * 2 : 0;
    const nextStringBytes = typeof value === "string" ? value.length * 2 : 0;
    const deltaBytes = (isNew ? VAR_ENTRY_BYTES + target.length * 2 : 0) + nextStringBytes - prevStringBytes;
    if (deltaBytes > 0 && totalMemoryBytes() + deltaBytes > memoryLimit) {
      return failure("memory_limit_exceeded");
    }
    vars.set(target, cloneValue(value));
    varBytes = Math.max(0, varBytes + deltaBytes);
    return null;
  };

  while (pc >= 0 && pc < program.instructions.length) {
    if (totalMemoryBytes() > memoryLimit) return failure("memory_limit_exceeded");
    if (steps >= fuel) return failure("fuel_exhausted");
    const instruction = program.instructions[pc]!;
    const beforeTraceErr = pushTrace(instruction, "before");
    if (beforeTraceErr) return beforeTraceErr;
    steps++;
    let nextPc = pc + 1;
    try {
      switch (instruction.op) {
        case "const": {
          const val = instruction.value;
          if (val === undefined) return failure("invalid_instruction", "undefined_const");
          if (typeof val === "number") {
            const checked = checkInteger(val);
            if (!checked.ok) return checked.failure;
            const error = writeTarget(instruction.target, checked.value);
            if (error) return error;
          } else {
            const error = writeTarget(instruction.target, val);
            if (error) return error;
          }
          break;
        }
        case "assign": {
          const error = writeTarget(instruction.target, read(instruction.value));
          if (error) return error;
          break;
        }
        case "binary": {
          const left = read(instruction.left);
          const right = read(instruction.right);
          if (left === undefined || right === undefined) return failure("uninitialized_read");
          let value: C408Value;
          if (instruction.operator === "+" || instruction.operator === "-" || instruction.operator === "*" || instruction.operator === "/" || instruction.operator === "%") {
            if (typeof left !== "number" || typeof right !== "number") return failure("type_error");
            if ((instruction.operator === "/" || instruction.operator === "%") && right === 0) return failure("type_error", "division_by_zero");
            const raw =
              instruction.operator === "+"
                ? left + right
                : instruction.operator === "-"
                  ? left - right
                  : instruction.operator === "*"
                    ? left * right
                    : instruction.operator === "/"
                      ? Math.trunc(left / right)
                      : left % right;
            const checked = checkInteger(raw);
            if (!checked.ok) return checked.failure;
            value = checked.value;
          } else if (instruction.operator === "==" || instruction.operator === "!=") {
            const eq = compareEquality(left, right);
            if (!eq.ok) return failure("type_error");
            value = instruction.operator === "==" ? eq.equal : !eq.equal;
          } else {
            if (typeof left !== "number" || typeof right !== "number") return failure("type_error");
            value =
              instruction.operator === "<"
                ? left < right
                : instruction.operator === "<="
                  ? left <= right
                  : instruction.operator === ">"
                    ? left > right
                    : left >= right;
          }
          const error = writeTarget(instruction.target, value);
          if (error) return error;
          break;
        }
        case "alloc": {
          if (instruction.length !== undefined && (!Number.isSafeInteger(instruction.length) || instruction.length < 0)) {
            return failure("invalid_instruction", "invalid_alloc_length");
          }
          const fieldEntries = Object.entries(instruction.fields ?? {});
          const slotCount = (instruction.length ?? 0) + fieldEntries.length;
          const fieldStringBytes = fieldEntries.reduce(
            (sum, [key, value]) => sum + key.length * 2 + (typeof value === "string" ? value.length * 2 : 0),
            0,
          );
          const allocBytes = HEAP_HEADER_BYTES + slotCount * HEAP_SLOT_BYTES + fieldStringBytes;
          const targetBytes = vars.has(instruction.target) ? 0 : VAR_ENTRY_BYTES + instruction.target.length * 2;
          if (totalMemoryBytes() + allocBytes + targetBytes > memoryLimit) {
            return failure("memory_limit_exceeded");
          }
          const object: HeapObject = {
            id: nextObjectId,
            generation: 1,
            live: true,
            fields: new Map(),
            initialized: new Set(),
            length: instruction.length,
            slotCount,
          };
          for (const [key, value] of fieldEntries) {
            if (value === undefined) return failure("invalid_instruction", "undefined_field_value");
            object.fields.set(key, cloneValue(value));
            object.initialized.add(key);
          }
          if (instruction.length !== undefined) {
            for (let i = 0; i < instruction.length; i++) object.fields.set(i, null);
          }
          heap.set(nextObjectId, object);
          heapBytes += allocBytes;
          const error = writeTarget(instruction.target, { objectId: nextObjectId++, generation: object.generation, fieldOrIndex: null });
          if (error) return error;
          break;
        }
        case "free": {
          const pointer = read(instruction.pointer);
          if (pointer === undefined) return failure("uninitialized_read");
          if (pointer === null) return failure("null_dereference");
          if (!isPointer(pointer)) return failure("wild_pointer");
          if (pointer.fieldOrIndex !== null && pointer.fieldOrIndex !== 0) {
            return failure("wild_pointer", "cannot_free_non_base_pointer");
          }
          const object = requirePointer(pointer);
          if (!object) return heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer");
          let freedFieldStringBytes = 0;
          for (const [key, value] of object.fields) {
            if (typeof key === "string") freedFieldStringBytes += key.length * 2;
            if (typeof value === "string") freedFieldStringBytes += value.length * 2;
          }
          object.live = false;
          object.generation++;
          object.fields.clear();
          object.initialized.clear();
          heapBytes = Math.max(
            0,
            heapBytes -
              (HEAP_HEADER_BYTES - HEAP_TOMBSTONE_BYTES) -
              object.slotCount * HEAP_SLOT_BYTES -
              freedFieldStringBytes,
          );
          break;
        }
        case "load": {
          const pointer = read(instruction.pointer);
          if (pointer === undefined) return failure("uninitialized_read");
          if (pointer === null) return failure("null_dereference");
          const object = requirePointer(pointer);
          if (!object) return isPointer(pointer) && heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer");
          const key = isPointer(pointer) ? pointer.fieldOrIndex : null;
          if (key === null) return failure("type_error", "root_pointer_has_no_load_field");
          if (typeof key === "number" && (object.length === undefined || key < 0 || key >= object.length)) return failure("out_of_bounds");
          if (!object.initialized.has(key)) return failure("uninitialized_read");
          const loaded = object.fields.get(key);
          const error = writeTarget(instruction.target, loaded === undefined ? null : loaded);
          if (error) return error;
          break;
        }
        case "store": {
          const pointer = read(instruction.pointer);
          if (pointer === undefined) return failure("uninitialized_read");
          if (pointer === null) return failure("null_dereference");
          const value = read(instruction.value);
          if (value === undefined) return failure("uninitialized_read");
          const object = requirePointer(pointer);
          if (!object) return isPointer(pointer) && heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer");
          const key = isPointer(pointer) ? pointer.fieldOrIndex : null;
          if (key === null) return failure("type_error", "root_pointer_has_no_store_field");
          if (typeof key === "number" && (object.length === undefined || key < 0 || key >= object.length)) return failure("out_of_bounds");
          const prevField = object.fields.get(key);
          const prevStrBytes = typeof prevField === "string" ? prevField.length * 2 : 0;
          const nextStrBytes = typeof value === "string" ? value.length * 2 : 0;
          const deltaStrBytes = nextStrBytes - prevStrBytes;
          if (deltaStrBytes > 0 && totalMemoryBytes() + deltaStrBytes > memoryLimit) {
            return failure("memory_limit_exceeded");
          }
          heapBytes = Math.max(0, heapBytes + deltaStrBytes);
          object.fields.set(key, cloneValue(value));
          object.initialized.add(key);
          break;
        }
        case "field": {
          const pointer = read(instruction.pointer);
          if (pointer === undefined) return failure("uninitialized_read");
          if (pointer === null) return failure("null_dereference");
          const object = requirePointer(pointer);
          if (!object) return isPointer(pointer) && heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer");
          if (!object.fields.has(instruction.field)) return failure("uninitialized_read");
          const error = writeTarget(instruction.target, { objectId: object.id, generation: object.generation, fieldOrIndex: instruction.field });
          if (error) return error;
          break;
        }
        case "index": {
          const pointer = read(instruction.pointer);
          if (pointer === undefined) return failure("uninitialized_read");
          if (pointer === null) return failure("null_dereference");
          const index = read(instruction.index);
          if (index === undefined) return failure("uninitialized_read");
          if (typeof index !== "number" || !Number.isInteger(index)) return failure("type_error");
          const object = requirePointer(pointer);
          if (!object) return isPointer(pointer) && heap.has(pointer.objectId) ? failure("use_after_free") : failure("wild_pointer");
          const baseOffset = isPointer(pointer) && typeof pointer.fieldOrIndex === "number" ? pointer.fieldOrIndex : isPointer(pointer) && pointer.fieldOrIndex === null ? 0 : NaN;
          if (!Number.isInteger(baseOffset)) return failure("type_error");
          const effectiveIndex = baseOffset + index;
          if (object.length === undefined || effectiveIndex < 0 || effectiveIndex >= object.length) return failure("out_of_bounds");
          const error = writeTarget(instruction.target, { objectId: object.id, generation: object.generation, fieldOrIndex: effectiveIndex });
          if (error) return error;
          break;
        }
        case "jump": {
          if (!isValidTarget(instruction.target, program.instructions.length)) return failure("invalid_jump_target");
          nextPc = instruction.target;
          break;
        }
        case "branch": {
          if (!isValidTarget(instruction.ifTrue, program.instructions.length) || !isValidTarget(instruction.ifFalse, program.instructions.length)) {
            return failure("invalid_jump_target");
          }
          const condition = read(instruction.condition);
          if (condition === undefined) return failure("uninitialized_read");
          if (typeof condition !== "boolean") return failure("type_error");
          nextPc = condition ? instruction.ifTrue : instruction.ifFalse;
          break;
        }
        case "return": {
          const value = instruction.value === undefined ? null : read(instruction.value);
          if (value === undefined) return failure("uninitialized_read");
          const returnTraceErr = pushTrace(instruction, "after");
          if (returnTraceErr) return returnTraceErr;
          return { status: "verified", value, steps, trace };
        }
        case "noop":
          break;
        default:
          return failure("invalid_instruction");
      }
    } catch (error) {
      return failure("type_error", error instanceof Error ? error.message : "interpreter_error");
    }
    const afterTraceErr = pushTrace(instruction, "after");
    if (afterTraceErr) return afterTraceErr;
    pc = nextPc;
  }
  return { status: "verified", value: null, steps, trace };
}

export const executeCSubset408 = runCSubset408;
export const run408Program = runCSubset408;
export const verifyCSubset408 = runCSubset408;
