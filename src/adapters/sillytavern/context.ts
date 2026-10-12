export interface SillyTavernContextSnapshot {
  characterId?: string;
  character?: unknown;
  chat?: unknown[];
  chatMetadata?: Record<string, unknown>;
}

/**
 * Adapter boundary for SillyTavern runtime access.
 * Keep all global getContext usage behind this layer.
 */
export function getSillyTavernContext(): SillyTavernContextSnapshot {
  const globalContext = globalThis as typeof globalThis & {
    getContext?: () => Record<string, unknown>;
  };

  if (!globalContext.getContext) {
    return {};
  }

  const context = globalContext.getContext();

  return {
    characterId: typeof context.characterId === 'string' ? context.characterId : undefined,
    character: context.characters,
    chat: Array.isArray(context.chat) ? context.chat : undefined,
    chatMetadata: (context.chatMetadata ?? {}) as Record<string, unknown>,
  };
}
