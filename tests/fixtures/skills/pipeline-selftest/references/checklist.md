# Package checklist

Walked before opening a pull request that adds or changes a Skill package.

1. `SKILL.md` has YAML frontmatter with `name` and a non-empty `description`.
   The `name` matches the directory name and the manifest's `name`.
2. `commandmate.skill.yaml` declares `capabilities` and `expected_outcomes` in
   terms a reviewer can check, not in terms of what the files contain.
3. `files:` is regenerated with `python3 scripts/manifest_files.py <dir>` after
   any payload change. Digest, size, kind, script flag and executable bit must
   match the bytes exactly.
4. `version` is bumped. A published version is immutable: the Catalog pins an
   install to its artifact digest, so changing the bytes behind a version breaks
   every receipt already written against it.
5. `declared_risk` is not lower than what CommandMate computes. Adding a script
   or a network host raises the computed risk whether or not the declaration
   follows.
6. `python3 scripts/validate.py` passes locally.
