# Issue tracker: GitHub

Repository: https://github.com/NLKASHEI/NLKaleido

Specs, investigations and implementation tickets belong in GitHub Issues. This choice follows the default GitHub configuration in `mattpocock/skills`.

## Working agreement

- An issue must separate **observed**, **inferred** and **proposed** behavior.
- Use one end-to-end tracer-bullet ticket for each independently testable change. Cite blocking issues as `Blocked by: #N` unless native issue dependencies are available.
- Only apply `ready-for-agent` when requirements, test seam and acceptance criteria are unambiguous.
- Link each PR to its issue, state executed evidence, and avoid editing `main` outside a reviewed release.
- PRs are not automatically feature-request triage inputs.

## Commands

- Create/read: `gh issue create` / `gh issue view <number>`.
- Submit changes: branch -> test -> code review -> PR -> review -> merge.
