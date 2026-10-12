# Variable-update engine: experimental TypeScript slice

## Status

Ready for integration testing: source code with pure scheduler, field-aware BM25F, deterministic observation builder, safe proposal envelope, model prompt and atomic-commit port.

**Not yet connected** to SillyTavern's live generation lifecycle or any actual model provider. This module does not silently run in the existing v0.10.0 bundle.

## Author flow

1. Declare field name, type/default, natural-language change rule, optional dependencies.
2. Select automatic check frequency in the author inspector, and optionally set a numeric field's **single-update max delta** (a hard local guard against excessive jumps). **Every reply is the default**, every 2/3/5 replies or disabled are available.
3. All automatic fields have a last-processed assistant logical turn. The scheduler groups similarly configured fields, never silently drops older turns if `batchSize` or `contextDepth` is low.
4. Mandatory due-turn evidence goes into the observation even when the BM25F ranking score is zero. Extra, older evidence is ranked per field `title/tags/summary/body`.
5. A provider receives a stable system instruction and dynamic, bounded observation. It proposes one explicit set/no-change decision per due field.
6. Validate field whitelist, JSON structure/types/ranges, reason and source citations, then call the injected **transactional** commit port.
7. Record watermarks **only after** the host reports durable success; unchanged fields also advance. Failure keeps their backlog.

## Integration contract

`runVariableUpdateCycle({scope,contract,snapshot,documents,completedTurns,lastProcessed,policies,propose,atomicCommit})` is the public entry.

- `scope`: current chat/branch ID. Evidence documents must match scope.
- `completedTurns`: ordered logical assistant turns, excluding canceled/incomplete/swipe-discarded content.
- `lastProcessed`: durable per-field watermark. **Do not advance it before transaction success.**
- `policies`: optional overrides (`every`, `skipLatest`, `batchSize`, `contextDepth`, `group`).
- `propose(observation, feedback?)`: model API adapter; pass `buildUpdatePrompt(observation)` to the model; JSON or fenced JSON replies are parsed. One constrained correction retry is allowed by default if validation fails (maximum 2 configured retries).
- `atomicCommit(tx)`: the host must verify `expected`, perform contract-valid state commit and watermark update, record an immutable audit, and durably dedupe the `scope,key` transaction; fail closed if the chat changed.
- `result.errors` reports invalid outputs, unsupported evidence and unsuccessful persistence **without** claiming the failed fields were updated.

`BM25FIndex` is deterministic, in-memory and bounded to 5,000 documents per chat. For edit/delete/replay, rebuild from the authoritative corpus. RRF helper is available for later dense ranking but dense service is not currently installed.

## Non-goals of this slice

- Making every turn *change* values. It should check often and freely choose **unchanged** when the story has no evidence.
- Cross-chat evidence injection or unapproved variable writes.
- Silent migration from prebuilt legacy NLKaleido or ACU database internals.
- Claiming BM25F alone can establish the truth of a model's story interpretation.
