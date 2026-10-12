# SillyTavern runtime bridge design decision

- Date: 2026-10-12
- Status: Experimental behind explicit opt-in

## Problem

The old release is prebuilt; newly authored contract, BM25F retrieval and scheduling must not write unknown legacy variable formats or trust ambiguous chat-save acknowledgements.

## Decision

1. Keep all experimental state in exactly **one new per-chat metadata key** `nlkaleido_update_runtime_v1`; include contract, snapshot, per-field watermarks, processed turn hashes, receipts and audit.
2. Require user confirmation for installation and separately for automatic model spending. Both are reversible *configuration decisions*; installation never overwrites existing data.
3. Use a synchronous current-context identity guard (chatId + characterId + groupId + metadata object) around all asynchronous proposal and save operations.
4. Extract completed assistant turns using ST native `chat`. Hash selected assistant text and preceding user text, halt updates on altered processed history.
5. Use native `generateRaw`, never start a visible story message to calculate variables. Listen only for `GENERATION_ENDED` (not `GENERATION_STOPPED`).
6. Because `saveMetadata` may swallow errors, require an independent same-origin `POST /api/chats/get` read-back proof before saying the metadata is saved. If proof is unavailable, quarantine further automatic writes.
7. Restrict verified ST writes to single-character chats until group save/read-back behavior is separately implemented and tested.

## Limits

Per-chat serialization and optimistic validation are **not** a distributed database transaction across multiple ST clients. A second tab or another extension may still race. In the long term, evaluate a server-side compare-and-set port or conflict-safe journal. No claims of production readiness before real browser integration QA.
