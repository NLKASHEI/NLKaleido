# Shujuku-inspired variable updates: source notes (2026-10-12)

Upstream reference: [AlbusKen/shujuku](https://github.com/AlbusKen/shujuku), inspected main tree at `63aacfb4b989e88b76681abf0b3df821cf0dfebb`, package `acu-star-database-iii`, description `龙血玄黄·数据库 1.0.0`.

These observations come from actual upstream source, not guesses. No upstream code is copied.

## A. Per-table distributed updating — verified

File: `src/service/table/update-scheduler.ts`, function `buildAutoUpdatePlan_ACU`.

- Each table has its own `updateConfig` with `contextDepth`, `updateFrequency`, `skipFloors`, `batchSize`, `groupId`. It falls back to global defaults.
- A frequency of **0** disables automatic updates.
- Scheduler compares logical assistant-message floors with each table's last completed floor.
- The complete unprocessed interval is kept separate from the narrower prompt context scope; it deliberately does not silently truncate historical catch-up to `contextDepth`.
- Tables sharing a schedule signature, indices, and batch size are grouped; checkpoint-boundary staging runs separately.
- `executeAutoUpdatePlan_ACU` handles grouped execution, errors and concurrency in service logic.

NLKaleido adaptation: units are **contract fields** instead of SQL tables. The default is every assistant reply for timely checks; manual/fixed fields opt out. Group requests by update turn slice + author group/context depth. An explicit watermark per field prevents losing unprocessed turns. One batch of oldest missed turns is processed first, and the following cycle resumes from committed watermarks.

## B. Chinese BM25 and hybrid retrieval — verified

File: `src/service/vector/summary-vector-hybrid-retrieval.ts`.

- Chinese characters and adjacent two-character grams are indexed; Latin text is normalized.
- Standard BM25 with `k1=1.5`, `b=0.75`, document frequencies and bounded corpus caching.
- Combines ranked candidate lists with reciprocal rank fusion (RRF).
- **This file is not a BM25F implementation.** It indexes chunk text, not differently weighted named fields.

NLKaleido adaptation: `src/update/bm25f.ts` introduces original, separate title/tags/summary/body term frequencies, field boosts and per-field length normalization, with deterministic per-chat indexing. The title/tags have stronger influence on matching; the conversation for *due turns* is still always included even if sparse search misses it. `src/update/fusion.ts` has a provider-neutral RRF utility for a future trusted dense retriever; **dense embeddings are not present**.

## Safety + update quality

Retrieval supplies **evidence**, never direct state writes. A proposal must explicitly mark every scheduled field as `set` or `unchanged`. Set operations require typed contract-valid values, reasons, and at least one citation from the current due batch. An injected or made-up evidence ID is rejected.

`runVariableUpdateCycle` requires the caller to provide a durable `atomicCommit` implementation that verifies previous values and persists **state + per-field watermarks + idempotency/audit** in one transaction. It does not fake exactly-once semantics with local browser storage.

The query does not promise real accuracy gains by itself. Before production, assess Chinese search Recall@5/10, field update precision/recall, incorrect-change rate, unupdated due-field rate, catch-up latency, malformed-model-response rate, and end-to-end persistence safety on a curated roleplay corpus.

## Remaining

- Build the actual SillyTavern chat/message extractor and idempotent metadata transaction adapter; guard for swipe/regen/change of chat and save failures.
- Connect a model provider with strict generation budget and cancellation. Validate output and preserve pending-review queues.
- Benchmark BM25 vs BM25F, optional dense+RRF, context cap and different group frequencies on frozen test cases.
- Add a UI scheduling/debug view for authors and player-visible committed changes only.
