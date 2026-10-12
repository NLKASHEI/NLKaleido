# Author Studio experimental UI

The frontend is an executable isolated browser preview for authors.

## Run

```sh
npm install
npm run ui:dev
npm run check
```

Open the URL printed by Vite. The compiled UI goes to `.ui-build/`. The original SillyTavern `dist/` and `manifest.json` are **unchanged**.

## Implemented

- Contract editor: browse, live search, type filter, **real namespace grouping** (not just alphabetical sorting), add, rename, delete, type/default/range/update timing, natural-language change rules, dependency picker and visibility.
- Contract JSON import/export, browser-local save, inline error feedback, player-view preview and structural checks.
- Audit demo: sample conversation/observation, explicit mock proposals, individual approvals, before/after diff, contract-checked commit, browser-local history and guarded rollback.
- Unified responsive light/dark design. Pending modules are labeled "规划中", not fake functional buttons.

## Precise boundaries

This is not a SillyTavern-connected release yet. Contract, state and audit history use isolated browser localStorage preview keys. Mock suggestions are deliberately identified as mock and no LLM requests occur. The real `createVariableController` enforces typed, atomic state changes. Saved incompatible states require explicit user reset. Remaining work includes installed-ST adapter, real LLM proposals and audit idempotency, provider lifecycle, and browser visual/accessibility QA.
