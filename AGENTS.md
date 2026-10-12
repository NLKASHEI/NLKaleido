# NLKaleido engineering guide

## Agent skills

### Issue tracker
Use GitHub Issues for design decisions, verified bugs and bounded implementation tickets. See `docs/agents/issue-tracker.md`.

### Triage labels
Canonical labels are `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs
This is a single-context repository. Read `GLOSSARY.md` and relevant `docs/adr/*.md` before changing architecture. See `docs/agents/domain.md`.

## Engineering rules

1. This is an independent SillyTavern UI extension, not an MVU or TavernHelper runtime extension. Preserve ST-native integration and the contract-governed state model.
2. Treat `main` at v0.10.0 as a legacy release artifact, not as verified buildable source. Do not hand-edit `dist/` to add features. Reconstruct auditable source and a reproducible build before shipping a replacement bundle.
3. Read https://docs.sillytavern.app/for-contributors/writing-extensions/ and the corresponding SillyTavern release source before relying on an event, method signature, settings persistence or injection behavior. Old handoff line numbers are hypotheses until rechecked.
4. Work in small, reversible vertical slices. For every slice, record the observable behavior, the public test seam, the failing-before/passing-after evidence, and the blast radius. Prefer red/green TDD for pure-engine logic.
5. Keep contract parsing, state transitions, memory ranking and cache scheduling independent of browser and ST globals. Put ST calls behind narrow adapters with capability detection.
6. Preserve data before migration. Version persistent data, support export and rollback, and never silently rewrite existing character cards or chat files.
7. Treat model output and imported data as untrusted. Validate operations before atomic commit; never use `eval` or `new Function` on author/model-controlled text.
8. Optional subsystems, including memory, story progression, dice and MVU migration, stay opt-in. An unavailable optional service must not break the principal chat path.
9. Treat third-party implementations as **references**, not vendored source. Record the upstream commit and license, and separately document the NLKaleido design decision.
10. Do not label an unexecuted test as passing, and do not claim real-ST or provider validation from reading docs alone.

## Before implementing

- Read `docs/research/baseline-and-upstreams.md` and `docs/roadmap/source-reconstruction.md`.
- Check the current `manifest.json` + `dist/` compatibility path and keep production output unchanged until an installable, tested replacement exists.
- Use Matt Pocock's small composable engineering skills as workflow guidance: https://github.com/mattpocock/skills (`setup-matt-pocock-skills`, `to-spec`, `to-tickets`, `tdd`, `code-review`, `pr`).
- Keep each pull request narrow. Include Summary, Evidence (including untested limits), and Merge Danger (door + blast radius).
