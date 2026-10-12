# ADR-0002: NLKaleido is a variable platform first

- Status: Accepted product direction
- Date: 2026-10-12

## Why the project exists

The primary user experience is easier creation and maintenance of dynamic roleplay variables:
authors should describe the state they want without fighting JSON; an LLM should be able to
update those variables correctly and efficiently; players should see dependable state.

The name **万花筒** represents an extensible composition of capabilities, not a mandate to
place every capability inside one core runtime.

## Decision

1. **The central feature is the variable system.** The stable public interface starts at
   author contract creation, state read/write, and controlled LLM-proposed updates.
2. The author workflow should be zero-code for common cards: editable field names, type,
   default, update timing, natural-language `changeRule`, dependencies, display choices
   and guardrails. Advanced JSON/DSL is an export, not the only entry point.
3. LLM update flow is a deliberate pipeline:
   `dueFields -> bounded Observation -> Agent proposal -> validate -> atomic commit -> audit/pending -> display`.
   The model may propose; only the local engine commits. Make rejected proposals explainable.
4. Support **simple single-request mode by default**, with opt-in multi-step Agent tools
   for complex cards. Both paths use the same contract, safety checks, and audit trail.
5. Keep the extension platform composable: storage, scheduler, renderer, cache strategy,
   model adapter and retrieval backend use documented replaceable interfaces.
6. Cache friendliness is a constraint on **request composition**; it must not force the
   author or LLM to hand-manage obscure prompt fragments.
7. Memory (event atoms, BM25F/dense/graph), CES, story engine, dice and migration are
   separately switchable features, **not requirements for a variable-only card**.
8. The same author/player console may expose optional modules, but installing or disabling
   a module must never disable core variable read/write.

## First proof of value

A new author can create a card with three related variables using a UI, run an LLM update
with an explicit reason for changed/unchanged fields, view an audit diff, undo an erroneous
update, and continue the same chat without manual patch editing. Until this is demonstrable
in SillyTavern, a memory feature or more complex architecture does not substitute for it.

## Non-goals

- A new prepackaged relationship/inventory/quest game system.
- Mandatory embedding, graph, or other external service.
- Any MVU or TavernHelper runtime dependency.
- AI output with unguarded write access.
