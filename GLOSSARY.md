# NLKaleido glossary

| Term | Meaning |
| --- | --- |
| 契约 / Contract | Author declaration of fields, rules, guards, ownership and display; the authoritative state schema. |
| 变量 Agent | Model proposes state changes; only the local engine can validate and commit them. |
| KaleidoCore | Pure logic for contracts, scheduling, observation, validation, applying operations and audit. |
| ST Adapter | Narrow bridge to SillyTavern events, model APIs and persistence. |
| Observation | Bounded, permission-checked projection of state sent to an Agent. |
| Changelog / Checkpoint | Auditable changes and durable reconstruction boundary. |
| L0–L3 | Stable-to-dynamic prompt segments; memory recall belongs in the dynamic tail (L3). |
| Memory Atom | Small sourced claim about an event or entity, with stable identity and lifecycle metadata. |
| Memory scope | Chat, run, character or global visibility boundary; never leak memories across unauthorized scopes. |
| BM25 | Lexical document-relevance ranking. |
| BM25F | Field-aware extension of BM25 with weighted per-field term frequencies and length normalization; not interchangeable with BM25. |
| Dense recall | Optional embedding-based candidate retrieval. |
| RRF | Rank-based fusion that can combine lexical and dense candidate lists. |
| CES | Optional conditional entry system for author-defined world-book switches. |
| Vertical slice | One narrow capability working from public API through persistence / UI and a behavior-focused test. |
