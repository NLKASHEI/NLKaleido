/** Minimal contract slice. The full author DSL is intentionally out of scope. */
export type FieldType = 'string' | 'number' | 'boolean' | 'list' | 'object' | 'kv';
export type FieldRule = {
  path: string;
  type: FieldType;
  default: unknown;
  display?: boolean;
  description?: string;
  updateMode?: string;
};
export type Contract = {
  version: 1;
  id: string;
  updateRules: Record<string, FieldRule>;
};

const SEGMENT = /^[\p{L}\p{N}_-]+$/u;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function parts(path: string): string[] {
  if (!path || typeof path !== 'string') throw new Error('字段路径不能为空');
  const segments = path.split('.');
  if (segments.some(s => !SEGMENT.test(s) || FORBIDDEN.has(s))) throw new Error(`非法字段路径: ${path}`);
  return segments;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Bound complexity and reject hostile/non-JSON structures, including dangerous keys. */
export function assertJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 12) throw new Error('嵌套层级超过 12');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !plain(value)) throw new Error('值必须为可序列化的 JSON');
  if (seen.has(value as object)) throw new Error('不能写入循环引用');
  seen.add(value as object);
  if (Array.isArray(value)) {
    if (value.length > 5000) throw new Error('数组过长');
    for (const entry of value) assertJson(entry, depth + 1, seen);
  } else {
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).length > 5000) throw new Error('对象字段过多');
    for (const [key, entry] of Object.entries(obj)) {
      if (FORBIDDEN.has(key)) throw new Error(`禁止危险字段名: ${key}`);
      assertJson(entry, depth + 1, seen);
    }
  }
  seen.delete(value as object);
}

export function copyJson<T>(value: T): T {
  assertJson(value);
  if (value === undefined) throw new Error('undefined 不是 JSON 值');
  return JSON.parse(JSON.stringify(value)) as T;
}

export function assertFieldValue(type: FieldType, value: unknown): void {
  assertJson(value);
  const valid = type === 'number' ? typeof value === 'number' :
    type === 'string' ? typeof value === 'string' :
    type === 'boolean' ? typeof value === 'boolean' :
    type === 'list' ? Array.isArray(value) : plain(value);
  if (!valid) throw new Error(`值与声明类型 ${type} 不匹配`);
  if (JSON.stringify(value).length > 64 * 1024) throw new Error('单字段超过 64KiB');
}

export function parseContract(input: unknown): Contract {
  if (!plain(input) || input.version !== 1 || typeof input.id !== 'string' || !input.id.trim()) {
    throw new Error('契约必须提供 version: 1 和非空 id');
  }
  if (!plain(input.updateRules)) throw new Error('updateRules 必须是字段表');
  const rules: Record<string, FieldRule> = Object.create(null);
  for (const [key, rule] of Object.entries(input.updateRules)) {
    parts(key);
    if (!plain(rule) || rule.path !== key || !['string', 'number', 'boolean', 'list', 'object', 'kv'].includes(String(rule.type))) {
      throw new Error(`契约字段不合法: ${key}`);
    }
    if (!Object.hasOwn(rule, 'default')) throw new Error(`字段缺少 default: ${key}`);
    const typed = rule as FieldRule;
    assertFieldValue(typed.type, typed.default);
    rules[key] = { path: key, type: typed.type, default: copyJson(typed.default),
      display: typed.display !== false, description: typeof typed.description === 'string' ? typed.description : undefined,
      updateMode: typeof typed.updateMode === 'string' ? typed.updateMode : undefined };
  }
  const paths = Object.keys(rules).sort();
  for (let i = 1; i < paths.length; i++) {
    const prev = paths[i - 1];
    const curr = paths[i];
    if (prev && curr?.startsWith(`${prev}.`)) throw new Error(`字段路径冲突: ${prev} / ${curr}`);
  }
  return { version: 1, id: input.id, updateRules: rules };
}
