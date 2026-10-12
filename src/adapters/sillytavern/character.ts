export interface CharacterCardSource {
  id?: string;
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  extensions?: Record<string, unknown>;
}

export interface CharacterRuntimeSource {
  id: string;
  name: string;
  card: CharacterCardSource;
}

export function getCurrentCharacter(source: unknown): CharacterRuntimeSource | null {
  if (!source || typeof source !== 'object') {
    return null;
  }

  const card = source as CharacterCardSource;
  if (!card.name) {
    return null;
  }

  return {
    id: card.id ?? card.name,
    name: card.name,
    card,
  };
}
