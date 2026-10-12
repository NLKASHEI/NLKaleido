# ADR-0001: Source-first, incremental reconstruction

- Status: Accepted as phase-one working direction
- Date: 2026-10-12

## Context

The accessible NLKaleido `main` branch at `5eb60e0c0094f641e5d573ec1b01f367bbd2b937` contains `manifest.json`, documentation and prebuilt `dist/` assets but no `src/`, `package.json`, source maps or executable tests. README describes a build and 443 tests that cannot be replayed from this checkout.

The supplied handoff describes a much larger intended system than the published source establishes. A bundle is not sufficient evidence for reliable future modification.

## Decision

1. Preserve the original release while rebuilding a first-class TypeScript source tree and repeatable build/test pipeline.
2. Prefer recoverable original source if it becomes available. Otherwise implement fresh, narrow vertical slices against documented public contracts, without decompiling a minified bundle into an authoritative codebase.
3. Establish behavioral compatibility tests at the ST adapter, state/contract API and memory-search boundary before replacing release outputs.
4. Make feature availability explicit: specification, built, unit-tested, ST-tested and provider-tested are different states.
5. The design is extension-first and does not depend at runtime on MVU or TavernHelper. Keep optional features detachable.
6. Change no shipped `dist/` bytes in this phase.

## Consequences

- First release work is slower but verifiable.
- Prebuilt v0.10.0 remains installable while new code is developed in isolation.
- Features advertised only in old README are unverified until reproduced via tests and manual validation.
- A later ADR must address chat-data migration, swipes, and scope boundaries before any storage format changes.

## Alternatives rejected

- Editing the minified JS in-place: hard to audit, test, and maintain.
- Rewriting every subsystem in one change: unbounded risk and no useful feedback loop.
