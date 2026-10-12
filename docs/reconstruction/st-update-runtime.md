# SillyTavern native update runtime bridge — experimental

## What is now implemented

A real *opt-in* author workflow is available in the separate preview extension:

1. Open the **✦ 万花筒·新版工作台** Author Studio panel in a **single-character** SillyTavern chat.
2. Edit your contract and click **保存**. Then click **↗ 绑定当前聊天（实验）** and confirm the operation. A new isolated per-chat metadata archive is created, **without overwriting** the legacy v0.10.0 state.
3. The extension requests an ST native chat save and independently checks `/api/chats/get` read-back for a matching archive. If verification fails, the write is marked **unconfirmed** and further auto-updates are locked until a reload and manual inspection.
4. Click **⚡ 自动更新设置**, read the Token/cost warning and explicitly enable it. **It is off by default for every chat**.
5. After an assistant message completes, `GENERATION_ENDED` triggers an update cycle through SillyTavern's documented `getContext().generateRaw({ systemPrompt, prompt })` using the **current selected model**. `GENERATION_STOPPED` does **not** trigger an update.
6. The engine schedules each due field, includes mandatory conversation evidence and BM25F-ranked history, requests a set/unchanged decision per field, validates it locally, then atomically persists a *single archive record* containing current values, field watermarks and an audit event. The write is read back from the ST server.
7. The **player HUD** reads the contract/snapshot from this chat-specific archive; recent changes are filtered by author visibility.

## Source grounding and limitations

Official ST extension guide: https://docs.sillytavern.app/for-contributors/writing-extensions/

Verified against ST `public/scripts/st-context.js` (`generateRaw`, `saveMetadata`, `getRequestHeaders`, `chat`, `eventTypes`), `public/scripts/events.js` (`GENERATION_ENDED`, `GENERATION_STOPPED`, `CHAT_CHANGED`) and `public/script.js` (`getChat` reads `POST /api/chats/get`; `saveMetadata` delegates to `saveChatConditional`, which can swallow save errors).

This is **not** a claim of full ACID database guarantees across tabs, browsers or other extension writers. It is a serialized optimistic per-chat transaction with a server read-back proof. Regeneration, swipes and edits affecting already processed turns are detected via SHA-256 of selected assistant text plus the preceding user message and cause a **fail-closed pause**, not silent rollback.

**Not yet supported:** group chat write confirmation, arbitrary concurrent external writers, editing already-processed history without explicit reconciliation, previous `variables.nlkaleido` data migration, recovery UI for all paused states, browser/live-SillyTavern manual installation QA, model quality benchmarks. Only single-character chat flow is writable in this experiment. Reinstalling an existing contract is refused rather than overwriting it.

The first installation intentionally seeds initial default values; it does not assume a historical old-variable snapshot. The runtime's `run` entry may process bounded older completed turns in later cycles (no lost backlog). Dense retrieval is not included. BM25F remains an evidence ranking aid, not a guarantee of correct story interpretation.

The preview extension is still on a development branch; `main` and its old `dist/` remain unchanged.

## Engineering seam

- `src/runtime/chat-timeline.ts`: chat scope, completed assistant turns, evidence documents and per-turn SHA-256 checks
- `src/runtime/update-ledger.ts`: serialized opt-in contract install, auto mode, verified transaction, watermarks, audit, idempotency receipts and stop-on-uncertain-save
- `src/runtime/st-verified-port.ts`: ST native save + independent read-back, single-character chats only
- `src/runtime/st-generation.ts`: official provider adapter using `generateRaw()`
- `src/runtime/st-events.ts`: `GENERATION_ENDED` event observer with cost-saving off-by-default switch
- `src/player/st-source.ts`: player HUD prefers the current chat's verified update archive

Run `npm run check` for TypeScript validation, Node tests, browser UI build and standalone ST preview package.
