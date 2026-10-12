# Source audit and upstream reference matrix

Date: 2026-10-12. All GitHub SHAs below refer to source observed on this date; upstream branches can move. This is a research note, not a claim that local functionality has been implemented.

## Published NLKaleido baseline

- `NLKASHEI/NLKaleido@5eb60e0c0094f641e5d573ec1b01f367bbd2b937` has `README.md`, `ALIGNMENT.md`, `FRONTEND_API.md`, `LICENSE`, `manifest.json` and `dist/index.js` plus `dist/chunks/*.js`.
- No source tree, build manifest, CI or test source is present in that published tree. A local build and the documented 443 tests cannot currently be reproduced from the published repo.
- The manifest declares 0.10.0 with `js: dist/index.js`; preserve it until the new build is deployable.
- A prior handoff describes design intent, not current GitHub implementation proof. Verify its ST 1.17.0-specific API assumptions against the actual target.

## References that have a concrete upstream

| Role | Repository and inspected path | Confirmed insight | Caution |
| --- | --- | --- | --- |
| SillyTavern host | [Official extension docs](https://docs.sillytavern.app/for-contributors/writing-extensions/) / [release source](https://github.com/SillyTavern/SillyTavern/tree/release) | UI extensions use `manifest.json` and can subscribe to ST events; `GENERATION_ENDED` covers completion/error, `GENERATION_STOPPED` means user stop. | Verify payload and sequence against pinned target source. |
| shujuku / ACU | [AlbusKen/shujuku](https://github.com/AlbusKen/shujuku/tree/63aacfb4b989e88b76681abf0b3df821cf0dfebb), `src/service/vector/summary-vector-hybrid-retrieval.ts` | In-code lexical BM25 with CJK character + bigram tokens; k1=1.5, b=0.75; hybrid candidates carry dense/BM25/RRF scores and bounded corpus cache. | This implementation is **BM25**, not evidence of BM25F. Copy no code without license review. |
| shujuku CDN | [gcore.jsdelivr.net/gh/AlbusKen/shujuku](https://gcore.jsdelivr.net/gh/AlbusKen/shujuku) | User-supplied CDN points to the same GitHub project path. | Unpinned CDN content can drift; inspect pinned GitHub source for reproducibility. |
| livingmemory | [livingmemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/tree/694f04b0a392ff0029444981296a182974742979), `core/retrieval/bm25_retriever.py` | SQLite FTS5-based BM25 lexical retrieval, memory-scoped filtering, source lifecycle. | Python/AstrBot-specific, AGPL-3.0; concept reference only. |
| yuzuki-Memory | [yuzuki-Memory](https://github.com/gaigai315/yuzuki-Memory/tree/440757279b4b1649fd63cec8501fe795b77945c0), `config/memory-io.js` | Table import/normalize, row identities and floor-scope handling. | Compare data compatibility; do not silently import its schema. |
| CFS-Suite | [CFS-Suite](https://github.com/OreoCoins/CFS-Suite/tree/c70fdab1628e885eca5d33bca0b7ae86e71d0a16), `cfs/core/injection_strategy.js` and `cfs/modules/rsi.js` | Stable-presence protocol and runtime-message cache-drift diagnostics. | The upstream may depend on its bundled MVU fork; reuse neither its runtime nor arbitrary network monkey-patches without explicit review. |
| MVU | [MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate/tree/54be11b09f21b1c4266e2d54b6f1ba9a3598db05) | Existing ecosystem and migration patterns to compare. | No MVU runtime dependency in NLKaleido. |
| worldbook-manager | [worldbook-manager](https://github.com/jerryzmtz/worldbook-manager) | Candidate for world-book entry semantics / compatibility research. | Verify exact branch, APIs and rights before adopting behavior. |
| World-master candidate | [DlSNlGHT/World](https://github.com/DlSNlGHT/World/tree/154de4b590378cd0bd851cfffcefd3d96741cf3f), `world-engine-evolution.js`, `world-engine-rules-loader.js` | Both filenames cited by the handoff exist at this revision. | Strong candidate, but original downloaded snapshot identity not yet compared. |
| AcuDice | [my-tavern-scripts](https://github.com/jerryzmtz/my-tavern-scripts/tree/d6b27e0c8d1fbbce910696be21f09d6f59e37877), `src/骰子系统/docs/API.md` | Public `roll`, `check`, `contest` API behavior and preset concepts. | Investigate licensing before copying any assets. |
| 梦鲸 | No verified public upstream yet | Keep handoff algorithm notes as hypotheses requiring tests. | Do not invent a GitHub repository or import undocumented code. |

## Memory-specific research conclusions

1. Near-memory append + far-memory archive from shujuku is an architectural **candidate**. Do not delete original turns or changelog entries until successful durable archival is verified; deletion policy needs its own ADR and migration plan.
2. Start by implementing a shared retrieval interface and a deterministic BM25 baseline, with Chinese mixed-language regression data and explicit scope filtering. Measure accuracy before adding complexity.
3. BM25F adds per-field frequency normalization and configurable boosts (e.g. entity/name, fact/body, aliases, time/location metadata). This is a proposed NLKaleido feature, **not** an existing verified shujuku feature.
4. Evaluate lexical-only, BM25F and hybrid candidates on the same query set. Report Recall@K, MRR/nDCG, p95 search time, cross-chat leakage (must be zero), and stale/deleted recall (must be zero).
5. Embeddings, graph traversal, reranking and query expansion should be optional adapters with budget caps, not mandatory dependencies. Use RRF when combining rankings of incompatible scales.
6. Injection always follows author permission and token budget, belongs in the dynamic L3 tail, and must preserve the stable prompt prefix. Never inject unauthorized or superseded atoms.

## Key ST compatibility fact to recheck

Older handoff material floated `GENERATION_STOPPED` as a completion anchor. Current [official extension documentation](https://docs.sillytavern.app/for-contributors/writing-extensions/) explicitly distinguishes `GENERATION_STOPPED` (stopped by user) from `GENERATION_ENDED` (finished or errored). Test the exact event order and completed-message persistence on the target ST version instead of treating either as guaranteed save completion.

## Research and licensing policy

Track source repo, full commit hash, inspected paths, verified behavior, incompatible assumptions and license before implementation. In particular, livingmemory advertises AGPL-3.0 and some other repositories have unavailable/unclear license metadata. Documenting an algorithm is not permission to paste implementation code.
