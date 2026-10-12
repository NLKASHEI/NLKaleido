import { copyJson } from '../core/contract.js';
import { createVariableController, type SnapshotStorage } from './controller.js';
import type { Snapshot } from '../core/state.js';

/**
 * Isolated development namespace. The original v0.10.0 `variables.nlkaleido`
 * payload is deliberately never touched in this slice.
 */
export const EXPERIMENTAL_METADATA_KEY = 'nlkaleido_rebuild_v1';

type Context = {
  chatMetadata: Record<string, unknown>;
  saveMetadata: () => Promise<unknown>;
  eventSource?: { on: (event: string, listener: (...args: unknown[]) => void) => void };
  event_types?: { CHAT_CHANGED?: string };
};

export function createStStorage(getContext: () => Context): SnapshotStorage {
  return {
    identity: () => getContext().chatMetadata,
    load: () => getContext().chatMetadata[EXPERIMENTAL_METADATA_KEY],
    save: async (snapshot: Snapshot) => {
      const ctx = getContext();
      const oldValue = ctx.chatMetadata[EXPERIMENTAL_METADATA_KEY];
      const hadValue = Object.hasOwn(ctx.chatMetadata, EXPERIMENTAL_METADATA_KEY);
      if (getContext().chatMetadata !== ctx.chatMetadata) throw new Error('聊天已切换，拒绝写入');
      ctx.chatMetadata[EXPERIMENTAL_METADATA_KEY] = copyJson(snapshot);
      try {
        await ctx.saveMetadata();
        if (getContext().chatMetadata !== ctx.chatMetadata) throw new Error('聊天已切换，存档状态需重新确认');
      } catch (cause) {
        // Restore the captured chat's object, never write to the newly active chat.
        if (hadValue) ctx.chatMetadata[EXPERIMENTAL_METADATA_KEY] = oldValue;
        else delete ctx.chatMetadata[EXPERIMENTAL_METADATA_KEY];
        throw new Error('存档失败，已恢复内存状态', { cause });
      }
    },
  };
}

/** Explicit opt-in for dev harnesses. Do not auto-register or replace v0.10.0 globals. */
export function createStVariableBridge(contract: unknown, getContext: () => Context) {
  const bridge = createVariableController(contract, createStStorage(getContext));
  const ctx = getContext();
  const event = ctx.event_types?.CHAT_CHANGED;
  if (event && ctx.eventSource) ctx.eventSource.on(event, () => bridge.reload());
  return bridge;
}
