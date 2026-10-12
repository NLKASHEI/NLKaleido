# Reconstruction roadmap (tracer bullets)

Status: proposed. The first PR installs engineering guardrails and research notes only. No production behavior changes and no claim of passing tests.

## Why this order?

Current GitHub contains v0.10.0 release bundles but not the project source/test tree. We cannot safely iterate on caching, state, memory or UI until the build is reproducible.

### R0: Source & baseline recovery

- Seek original TypeScript/Vue sources, package lock, configuration and tests in local backups / historic workspace. If unavailable, explicitly reconstruct from public APIs.
- Create minimal reproducible build/test setup while preserving `manifest.json` and current `dist/`.
- Build a smoke test: packaged extension loads and exposes the documented public variable interface. Mark real-ST checks separately.
- Done when a clean clone can build an output and execute its test suite, and release differences are understood.

### R1: Single-variable end-to-end slice (blocked by R0)

- A minimal contract can declare a field, initialize state, accept or reject an op, persist to a chat and update a simple panel view.
- Test seam: public core command/contract interface + ST adapter fake; no private-method tests.
- Handle swipes, chat change, duplicate completion events and save failure explicitly before calling it complete.

### R2: Agent and cache guardrails (blocked by R1)

- One nonstreaming background proposal, due-field scheduling, observation permissions, validation, pending, changelog and rollback.
- Keep static L0-L2 before L3 dynamic state. Verify prompt composition against actual final outbound request.
- Provider usage metrics are optional; never fabricate hit rate when a provider omits usage.

### R3: Basic author/player UI (blocked by R1/R2)

- One screen to define contract fields without hand-editing JSON, inspect state, inspect pending and export a backup.
- Demonstrate bright/dark theme and installation in target ST version.

### R4: Memory baseline (blocked by persistence safety and R2 cache seam)

- Atomic facts with immutable source identifiers, chat/run scope, confidence and explicit supersession, plus a deterministic BM25 retrieval baseline.
- Human-reviewable test fixture of roleplay questions with expected memory IDs. Query log must show why each memory was included.
- Ship no embedding dependency or graph memory by default.

### R5: BM25F and hybrid memory (blocked by R4)

- Add field boosts and field-specific length normalization without breaking the retriever API; test short names vs verbose summaries and rare Chinese terms.
- Compare BM25 vs BM25F vs dense + RRF on the fixed corpus, record per-category Recall@5/10, MRR/nDCG, p95 time, token budget and false-recall rate.
- Handle reindex after edit, delete, scope change and memory merge; prove no stale or cross-chat result.

### R6: Optional subsystems (after stable core)

- CES/worldbook integration, plot engine, dice, migration and other extensions in separate, reversible slices.
- Keep every optional subsystem off the critical generation path when disabled.

## Workflow

1. Define observable behavior and its test seam in an Issue.
2. Run failing test -> smallest implementation -> passing test -> review (per mattpocock/skills).
3. Open a narrowly scoped PR, include evidence and merge danger; do not merge an untested bundle.
4. Keep issue statuses distinct: designed, implemented, unit-tested, installed-on-ST, exercised-with-provider.

## Unknowns / decisions not concealed

- Whether the user has the missing source files from the original workspace.
- Target live SillyTavern version and provider-specific model API behavior.
- Exact message, swipe and chat-metadata save semantics for end-of-generation handling.
- Original Dream Whale implementation availability.
