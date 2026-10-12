import { copyJson, parseContract, type Contract } from '../core/contract.js';
import { applyValues, getValue, readSnapshot, type Snapshot } from '../core/state.js';

export type VariableDescriptor = {
  path: string; type: string; value: unknown; display: boolean; frontendWritable: true; description?: string;
};
export type SetResult = { ok: true; changed: string[] } | { ok: false; error: string };
export type SnapshotStorage = {
  /** Object identity must change when a chat changes. */
  identity(): object;
  load(): unknown;
  save(snapshot: Snapshot): Promise<void>;
};

export function createVariableController(raw: unknown, storage: SnapshotStorage) {
  const contract: Contract = parseContract(raw);
  let active = storage.identity();
  let state = readSnapshot(contract, storage.load());
  let queue: Promise<unknown> = Promise.resolve();
  const observers = new Set<(values: VariableDescriptor[]) => void>();

  function assertIdentity(): void {
    if (active !== storage.identity()) throw new Error('聊天已切换，旧请求已取消');
  }
  function list(): VariableDescriptor[] {
    return Object.values(contract.updateRules).map(rule => ({
      path: rule.path, type: rule.type, value: getValue(contract, state, rule.path),
      display: rule.display !== false, frontendWritable: true as const,
      ...(rule.description ? { description: rule.description } : {}),
    }));
  }
  function notify(): void {
    for (const observer of observers) {
      try { observer(list()); } catch (e) { console.warn('[NLKaleidoNext] listener error', e); }
    }
  }
  function syncChat(): void {
    const identity = storage.identity();
    if (identity === active) return;
    const fresh = readSnapshot(contract, storage.load());
    active = identity;
    state = fresh;
    notify();
  }
  function get(path: string): unknown {
    syncChat();
    return getValue(contract, state, path);
  }
  function setMany(updates: Record<string, unknown>): Promise<SetResult> {
    let input: Record<string, unknown>;
    try { input = copyJson(updates); } catch (error) {
      return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    const expectedIdentity = storage.identity();
    const operation = async (): Promise<SetResult> => {
      if (storage.identity() !== expectedIdentity) return { ok: false, error: '聊天已切换，取消旧聊天写入' };
      syncChat();
      try {
        const { snapshot, changed } = applyValues(contract, state, input);
        if (!changed.length) return { ok: true, changed: [] };
        assertIdentity();
        await storage.save(snapshot);
        assertIdentity();
        state = snapshot;
        notify();
        return { ok: true, changed };
      } catch (error) {
        if (error instanceof Error && /存档失败|聊天已切换/.test(error.message)) throw error;
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    get,
    list: () => { syncChat(); return list(); },
    set: (path: string, value: unknown) => setMany({ [path]: value }),
    setMany,
    subscribe: (observer: (values: VariableDescriptor[]) => void) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    reload: syncChat,
    snapshot: () => { syncChat(); return copyJson(state); },
  };
}
