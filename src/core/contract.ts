/** Versioned contract for author-defined variable state. UI metadata is optional. */
export type FieldType = 'string' | 'number' | 'boolean' | 'list' | 'object' | 'kv';
export type FieldRule = {
  path: string;
  type: FieldType;
  default: unknown;
  label?: string;
  description?: string;
  changeRule?: string;
  updateMode?: string;
  /** Assistant replies between checks: default 1; 0 disables auto updates. */
  updateEvery?: number;
  dependencies?: string[];
  min?: number;
  max?: number;
  /** Optional hard limit on absolute change per accepted numeric update. */
  maxDelta?: number;
  display?: boolean;
};
export type Contract = { version: 1; id: string; updateRules: Record<string, FieldRule> };

const SEGMENT = /^[\p{L}\p{N}_-]+$/u;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const TYPES: FieldType[] = ['string', 'number', 'boolean', 'list', 'object', 'kv'];
export const FIELD_TYPES = TYPES;

export function parts(path: string): string[] {
  if (!path || typeof path !== 'string') throw new Error('字段路径不能为空');
  const segments = path.split('.');
  if (segments.some(s => !SEGMENT.test(s) || FORBIDDEN.has(s))) throw new Error('非法字段路径: ' + path);
  return segments;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Reject hostile JSON, non-finite numbers, cycles and unbounded nesting. */
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
      if (FORBIDDEN.has(key)) throw new Error('禁止危险字段名: ' + key);
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
  if (!valid) throw new Error('值与声明类型 ' + type + ' 不匹配');
  if (JSON.stringify(value).length > 64 * 1024) throw new Error('单字段超过 64KiB');
}

export function assertRuleValue(rule: FieldRule, value: unknown): void {
  assertFieldValue(rule.type, value);
  if (rule.type === 'number' && typeof value === 'number') {
    if (rule.min !== undefined && value < rule.min) throw new Error(rule.path + ' 小于最小值 ' + rule.min);
    if (rule.max !== undefined && value > rule.max) throw new Error(rule.path + ' 大于最大值 ' + rule.max);
  }
}

function optionalText(rule: Record<string, unknown>, key: string, limit: number): string | undefined {
  const value = rule[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > limit) throw new Error(key + ' 必须是 ' + limit + ' 字以内的文本');
  return value;
}

export function parseContract(input: unknown): Contract {
  if (!plain(input) || input.version !== 1 || typeof input.id !== 'string' || !input.id.trim()) {
    throw new Error('契约必须提供 version: 1 和非空 id');
  }
  if (!plain(input.updateRules)) throw new Error('updateRules 必须是字段表');
  if (Object.keys(input.updateRules).length > 300) throw new Error('字段数不能超过 300');
  const rules: Record<string, FieldRule> = Object.create(null);
  for (const [key, raw] of Object.entries(input.updateRules)) {
    parts(key);
    if (!plain(raw) || raw.path !== key || !TYPES.includes(raw.type as FieldType)) {
      throw new Error('契约字段不合法: ' + key);
    }
    if (!Object.hasOwn(raw, 'default')) throw new Error('字段缺少 default: ' + key);
    if (raw.display !== undefined && typeof raw.display !== 'boolean') throw new Error('display 必须是布尔值: ' + key);
    if (raw.min !== undefined && (typeof raw.min !== 'number' || !Number.isFinite(raw.min))) throw new Error('min 必须是有限数字: ' + key);
    if (raw.max !== undefined && (typeof raw.max !== 'number' || !Number.isFinite(raw.max))) throw new Error('max 必须是有限数字: ' + key);
    if (raw.type !== 'number' && (raw.min !== undefined || raw.max !== undefined || raw.maxDelta !== undefined)) throw new Error('只有数值字段能设范围: ' + key);
    if (raw.maxDelta !== undefined && (typeof raw.maxDelta !== 'number' ||
        !Number.isFinite(raw.maxDelta) || raw.maxDelta < 0 || raw.maxDelta > 1000000000))
      throw new Error('单次最大变化必须是非负有限数字: ' + key);
    if (typeof raw.min === 'number' && typeof raw.max === 'number' && raw.min > raw.max) throw new Error('最小值不能大于最大值: ' + key);
    if (raw.updateEvery !== undefined &&
        (!Number.isSafeInteger(raw.updateEvery) || (raw.updateEvery as number) < 0 || (raw.updateEvery as number) > 1000))
      throw new Error('更新频率必须是 0 到 1000 的整数: ' + key);
    const deps = raw.dependencies === undefined ? [] : raw.dependencies;
    if (!Array.isArray(deps) || deps.length > 32 || deps.some(d => typeof d !== 'string')) throw new Error('依赖变量列表不合法: ' + key);
    for (const dep of deps) parts(dep);
    if (new Set(deps).size !== deps.length) throw new Error('存在重复依赖: ' + key);
    const rule: FieldRule = {
      path: key, type: raw.type as FieldType, default: copyJson(raw.default),
      display: raw.display !== false,
      label: optionalText(raw, 'label', 80),
      description: optionalText(raw, 'description', 1000),
      changeRule: optionalText(raw, 'changeRule', 3000),
      updateMode: optionalText(raw, 'updateMode', 80),
      ...(raw.updateEvery !== undefined ? { updateEvery:raw.updateEvery as number } : {}),
      dependencies: [...deps],
      ...(raw.min !== undefined ? { min: raw.min as number } : {}),
      ...(raw.max !== undefined ? { max: raw.max as number } : {}),
      ...(raw.maxDelta !== undefined ? { maxDelta: raw.maxDelta as number } : {}),
    };
    assertRuleValue(rule, rule.default);
    rules[key] = rule;
  }
  const names = Object.keys(rules).sort();
  for (let i = 1; i < names.length; i++) {
    const prev = names[i - 1];
    const current = names[i];
    if (prev && current?.startsWith(prev + '.')) throw new Error('字段路径冲突: ' + prev + ' / ' + current);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visiting.has(path)) throw new Error('依赖变量存在循环: ' + path);
    if (visited.has(path)) return;
    const rule = rules[path];
    if (!rule) throw new Error('依赖变量未声明: ' + path);
    visiting.add(path);
    for (const dep of rule.dependencies ?? []) visit(dep);
    visiting.delete(path);
    visited.add(path);
  };
  names.forEach(visit);
  return { version: 1, id: input.id, updateRules: rules };
}
