# Player HUD (read-only preview)

The player panel is intentionally much smaller than the author-facing studio:
a floating **✦ 角色状态** capsule opens a narrow, collapsible status bar. Only ordinary language and visual status indicators appear; no contracts, developer JSON or manual editing.

## Preview

- In development run `npm install && npm run ui:dev` and open **/player.html** to inspect a clearly labeled local demonstration with the same preview contract and saved demo state used by Author Studio.
- In SillyTavern, install the separate experimental preview extension (see [st-preview.md](./st-preview.md)). A second floating **角色状态** button appears in the bottom-right.
- The ST player's panel reads **only** `chatMetadata.nlkaleido_rebuild_v1`, and only when the current chat has a matching contract saved under the experimental UI contract key. If missing, it displays a descriptive empty state.
- It **does not** read or modify the legacy `variables.nlkaleido` payload and does not substitute sample values in a live chat. This is a deliberate migration boundary.
- Status is read-only and refreshes when opened, manually, or after ST chat/generation events if available. No LLM execution or chat mutation.

## Design

- **Default closed:** a 44px-high unobtrusive capsule. Mobile viewport gets a narrow popover with scrollable content.
- **Open:** character/project name, at most two prominent metrics (e.g. affection and trust), up to six small status items, then optionally expandable inventory, recent visible changes and public clues.
- Missing categories are omitted. Arbitrary new public fields still render in a generic status tile. Hidden fields are excluded from all outputs, including recent changes.
- Recent changes only come from supplied committed history. In current ST preview no audited history feed is connected, so this section stays absent rather than showing fictitious events.
- The current ST data source loads using the official extension context. Tested in simulated adapter, but not yet in the user's running instance.

## Safety and limitations

This component makes **no writes**. All interpolated labels/descriptions are HTML-escaped. A failed source read cannot fall back to another chat's data. There is no automatic or invisible migration from the old v0.10.0 state; native contract storage and audit attachment are later tasks.
