---
name: pipeline-selftest
description: Minimal reference package used to exercise the commandmate-skills release pipeline end to end. Not an official Skill and never published to the Catalog.
---

# pipeline-selftest

This package exists so the validation and release pipeline in this repository has
something real to run against before any official Skill is written. It is the
smallest package that is still a *complete* one: `SKILL.md` plus
`commandmate.skill.yaml` plus one reference file under a subdirectory, which is
enough to exercise directory entries, nested payload paths and the manifest
file-set comparison.

It is a fixture, not a capability. Nothing here is meant to be installed.

## What a real Skill puts here

An official Skill (see [#1239](https://github.com/Kewton/CommandMate/issues/1239),
[#1240](https://github.com/Kewton/CommandMate/issues/1240),
[#1241](https://github.com/Kewton/CommandMate/issues/1241)) replaces this section
with the procedure an Agent should follow: the steps, the order, and what to do
when a step cannot be completed. Keep it addressed to the Agent, in the
imperative, and keep CommandMate-specific distribution metadata out of it —
that belongs in `commandmate.skill.yaml`.

## Structure this fixture demonstrates

1. Frontmatter `name` matches `commandmate.skill.yaml`'s `name`, which matches
   the directory name. All three must agree or the package is refused.
2. Supporting material lives in a subdirectory and is declared in the manifest's
   `files:` block with its own digest.
3. No scripts and no executable files, so the computed risk stays `low` and
   matches what is declared.

See [`references/checklist.md`](./references/checklist.md) for the checklist a
contributor walks before opening a pull request.
