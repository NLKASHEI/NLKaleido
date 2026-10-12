# Release readiness and SillyTavern install audit (2026-10-12)

## Verified actual repository state

- Default branch: `main` at `5eb60e0c0094f641e5d573ec1b01f367bbd2b937`.
- Main has `manifest.json`, `dist/index.js`, three prebuilt chunks and documentation; **no** `src/`, `package.json`, CI or new UI.
- Main manifest: `js: "dist/index.js"`, `version: "0.10.0"`, `auto_update: false`.
- New source lives only on a stack of experimental draft PRs (#1, #2, #5, #6, #7, #8) and this release-audit branch. The root manifest and old `dist/` were **intentionally not changed**.
- The independent UI preview is built into `.preview-extension-build/index.js` with `preview-extension/manifest.json` (`js: "index.js"`, alpha version). This artifact can be manually installed as a **separate extension**, but Git updates to the original `main` extension do not install it automatically.

Official installation documentation allows specifying the branch when installing a Git repository extension. The manifest's `auto_update` flag controls ST automatic updates when ST changes; it does not move branch changes into `main`.

Sources:
- https://docs.sillytavern.app/for-contributors/writing-extensions/
- https://docs.sillytavern.app/extensions/
- https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js
- https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/events.js

## What must change before a normal user sees the new version

1. Merge the tested source/CI/history into `main`, without changing the root manifest. This is safe as a source-first integration but still **does not deploy new behavior**.
2. Build a **release entry point** and commit its real, deterministic JS/CSS artifacts. Decide whether to preserve original M9/M13/M15/M16/author functionality or stage a separately named experimental extension. Do not replace `dist/index.js` with the smaller preview bundle: that would remove legacy behavior and the published `window.NLKaleido.variables` API.
3. Verify migration of existing `chatMetadata.variables.nlkaleido` and author contract vocabulary. v0.10.0 uses `every_turn` / `every_n_turns` and `everyN`; the experimental scheduler uses `afterReply` / `updateEvery`. Without an explicit mapping, older cards can silently become non-automatic. Preserve old data and provide backup/rollback UI.
4. Run manual tests on actual SillyTavern: extension loaded in the manager, author and player surfaces, normal AI reply, STOP, retry, swipe, message edits, chat switch during model request, missing provider, existing legacy variables and group chat. Confirm committed storage by reload and server read-back.
5. Only after live QA change the root manifest `js` path if necessary, bump version, update root documentation and release assets. Check installation and update of a clean copy and an existing v0.10.0 copy. Test automated updates separately if turning `auto_update` on.
6. Preserve an instant rollback path to the old `manifest.json` / `dist/` and do not automatically destroy old chat keys.

## Specific ST compatibility observations from official source

- `getContext` is publicly exported from `public/scripts/extensions.js` and exposes `chat`, `chatMetadata`, `getRequestHeaders`, `generateRaw`, events, current character and saveMetadata.
- The native `saveMetadata()` delegates to `saveChatConditional()`, which can catch and log save errors instead of throwing. An awaited save call alone cannot be treated as a confirmed persistent transaction. The experimental single-character port independently reads back the chat header from `POST /api/chats/get`; group chats remain unsupported.
- **Important bug uncovered during this audit:** `hideStopButton()` emits `GENERATION_ENDED`. `stopGeneration()` invokes `hideStopButton()` and then emits `GENERATION_STOPPED`. Thus a plain `GENERATION_ENDED` listener can mistakenly update variables on manual Stop. The experimental fix defers the callback and suppresses it on Stop, with a regression test. Other failure/partial-message conditions still require live QA.
- `GENERATION_STARTED` / `GENERATION_STOPPED` / `GENERATION_ENDED` are available in the official event catalog.
- The source and tests compile in GitHub Actions; this is **not** proof of correct installed-browser behavior, model-provider compatibility or save-proof behavior on every ST build.

## Safe rollout recommendation

- Leave released `main` v0.10.0 unchanged until release blockers above are cleared.
- Make this code stack reviewable as a **draft main-targeted integration PR** with published tests and docs, but no released entrypoint switch.
- Prefer a separately installed preview for the first real ST acceptance run.
- Gate model-calling auto-updates behind an explicit toggle (currently defaults off) and remain fail-closed on uncertain writes.
