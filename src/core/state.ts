import { assertFieldValue, assertJson, copyJson, parseContract, parts, type Contract } from './contract.js';

export type Snapshot = { schemaVersion: 1; contractId: string; stat_data: Record<string, unknown> };

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function getNested(data: Record<string, unknown>, path: string): unknown {
  let value: unknown = data;
  for (const key of parts(path)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !has(value as Record<string, unknown>, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function putNested(data: Record<string, unknown>, path: string, value: unknown): void {
  const segs = parts(path);
  let node = data;
  for (const key of segs.slice(0, -1)) {
    if (!has(node, key)) node[key] = Object.create(null);
    const child = node[key];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) throw new Error(`路径冲突: ${path}`);
    node = child as Record<string, unknown>;
  }
  const leaf = segs.at(-1);
  if (!leaf) throw new Error('字段路径不能为空');
  node[leaf] = copyJson(value);
}

export function initialSnapshot(contract: Contract): Snapshot {
  const rules = parseContract(contract).updateRules;
  const stat_data: Record<string, unknown> = Object.create(null);
  for (const rule of Object.values(rules)) putNested(stat_data, rule.path, rule.default);
  return { schemaVersion: 1, contractId: contract.id, stat_data: copyJson(stat_data) };
}

export function readSnapshot(contract: Contract, saved: unknown): Snapshot {
  if (saved == null) return initialSnapshot(contract);
  if (typeof saved !== 'object' || Array.isArray(saved) || saved === null) throw new Error('无法识别的存档格式，拒绝覆盖');
  const raw = saved as Partial<Snapshot>;
  if (raw.schemaVersion !== 1 || raw.contractId !== contract.id || !raw.stat_data || typeof raw.stat_data !== 'object' || Array.isArray(raw.stat_data)) {
    throw new Error('存档版本或契约不匹配，拒绝覆盖');
  }
  assertJson(raw.stat_data);
  const next = initialSnapshot(contract);
  for (const rule of Object.values(contract.updateRules)) {
    const value = getNested(raw.stat_data, rule.path);
    if (value !== undefined) {
      assertFieldValue(rule.type, value);
      putNested(next.stat_data, rule.path, value);
    }
  }
  return next;
}

export function getValue(contract: Contract, snapshot: Snapshot, path: string): unknown {
  if (!Object.hasOwn(contract.updateRules, path)) return undefined;
  const value = getNested(snapshot.stat_data, path);
  return value === undefined ? undefined : copyJson(value);
}

/** Validate every update before writing any value. The returned state is a new object. */
export function applyValues(contract: Contract, snapshot: Snapshot, updates: Record<string, unknown>): { snapshot: Snapshot; changed: string[] } {
  if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) throw new Error('更新应是路径到值的映射');
  const entries = Object.entries(updates);
  for (const [path, value] of entries) {
    if (!Object.hasOwn(contract.updateRules, path)) throw new Error(`变量未在契约声明: ${path}`);
    const rule = contract.updateRules[path];
    if (!rule) throw new Error(`变量未声明: ${path}`);
    assertFieldValue(rule.type, value);
  }
  const next: Snapshot = copyJson(snapshot);
  const changed: string[] = [];
  for (const [path, value] of entries) {
    if (JSON.stringify(getValue(contract, snapshot, path)) === JSON.stringify(value)) continue;
    putNested(next.stat_data, path, value);
    changed.push(path);
  }
  return { snapshot: next, changed };
}
