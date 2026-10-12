# Rebuild experiment: contract/state/storage vertical slice

This is an **isolated experimental TypeScript library**, not a replacement SillyTavern extension release.
Legacy `manifest.json` and `dist/` are intentionally unchanged.

## Current testable behavior

- Author-declared default values; Chinese dot-path fields, `string/number/boolean/list/object/kv` types
- Safe `get/list/set/setMany/subscribe` surface with defensive copies, synchronous rule checks and queued atomic commits
- Chat-isolated state via a narrow ST `chatMetadata` adapter
- Save-failure rollback, rejection of invalid JSON and basic chat-switch safeguards
- Old `variables.nlkaleido` payload is **not read or written**. Experiment data uses `chatMetadata.nlkaleido_rebuild_v1`.

The API is intended for a developer-run harness. It is **not** registered on `window.NLKaleido`,
has no released UI and does not connect to the primary model. Installing the repository normally
still runs v0.10.0.

## Build & test

Node.js 22+ recommended:

```sh
npm install
npm run check
```

`check` performs TypeScript type checking and eight public-API behavior tests. The generated
`.build/` folder is excluded from commits. The CI job checks the same commands.

## Public test seam

```ts
import { createVariableController } from './.build/index.js';

const contract = {
  version: 1,
  id: 'demo',
  updateRules: {
    '角色.好感度': { path: '角色.好感度', type: 'number', default: 50 },
  },
};
const api = createVariableController(contract, storageProvider);
await api.set('角色.好感度', 52);
```

Production readiness **not claimed**. Pending: full author DSL and zero-code authoring,
Agent proposal schema, validation/pending/audit/rollback, tested ST event lifecycle,
source recovery/migrations, browser UI, and real-provider tests.

## Product direction

See ADR-0002. The product is a **variable-authoring and LLM-update framework first**.
Memory and other capabilities are optional plugins. A future Agent is allowed to propose
operations but never commit outside the local contract. This experiment has no Agent yet.
