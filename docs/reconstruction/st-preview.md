# Try the new UI *inside* SillyTavern (isolated preview)

This package was designed against the [official ST extension guide](https://docs.sillytavern.app/for-contributors/writing-extensions/). It is a **separate opt-in extension** so the existing v0.10.0 NLKaleido runtime is not replaced.

## Build

```sh
npm install
npm run check
```

The result is the folder `.preview-extension-build/` containing `manifest.json` and a bundled `index.js`. CI uploads the same folder as the `nlkaleido-st-author-studio-preview` workflow artifact.

## Install manually

1. Create a folder `NLKaleido-AuthorStudio-Preview` inside your SillyTavern **user's extensions directory** (usually `data/<user-handle>/extensions/`).
2. Copy both generated files from `.preview-extension-build/` into that new folder.
3. Reload SillyTavern and click the floating **✦ 万花筒·新版工作台** button. Close with the × button, Escape or click outside the preview.
4. Disable/remove this preview extension whenever you want. It never changes the old NLKaleido manifest or bundles.

**Do not install the repository root URL as a second copy.** It is the existing v0.10.0 release. This preview must be installed from the generated subfolder/artifact as documented.

## Safety notes

- The preview uses **Shadow DOM** so its extensive dashboard stylesheet does not override existing SillyTavern CSS.
- Its browser-local demo contracts/updates/history do **not** read, intercept or modify live chat metadata, released extension variables, provider requests or generation events.
- The screen is a visual/functional preview. It is **not** yet a production replacement, LLM agent, or evidence of live ST integration test.
- Real ST storage / author-card export / generation event integration will be implemented only after this isolated mount is stable.
