import { getSillyTavernContext } from '../adapters/sillytavern/context';
import { getCurrentCharacter, CharacterRuntimeSource } from '../adapters/sillytavern/character';

export interface RuntimeBootstrap {
  character: CharacterRuntimeSource | null;
  initialized: boolean;
}

export function bootstrapCharacterRuntime(): RuntimeBootstrap {
  const context = getSillyTavernContext();

  return {
    character: getCurrentCharacter(context.character),
    initialized: Boolean(context.character),
  };
}
