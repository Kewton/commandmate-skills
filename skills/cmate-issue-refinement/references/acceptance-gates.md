# Acceptance gates — recommend the block, never write it

An Issue's acceptance criteria are prose. The thing that actually decides whether
a run passed is the exit code of `commandmate wait --verify`, which runs the gates
declared in the target repository's `.commandmate/verify.yaml`. **Those are two
different things.** "The repo's gates are green" and "this Issue is finished" are
not the same proposition.

The `acceptance-gates` block carries the part of the difference that a machine can
measure — and only that part — from the Issue into the verdict.

**This document mirrors a notation it does not own.** The source of truth is
`references/acceptance-gates-notation.md` in `cmate-orchestrate`. Do not extend
the notation here. The repository's conformance test
(`tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs`) holds
every block shipped in this package byte-identical to what that document shows.

## What this Skill does with it

It **recommends**. It does not write.

This Skill never edits an Issue ([`safety.md`](./safety.md) §2–§3): `github_writes`
is always the empty array, and `proposed_issue_body` is a proposal a person
applies as a separate, approved action. A block therefore reaches GitHub only when
a human puts it there, or when `cmate-issue-authoring` registers an Issue whose
body it authored. Recommending is the whole of this Skill's part.

Concretely, when Step 7 generates or extends the acceptance-criteria section:

1. Split the criteria into the ones an existing gate already decides and the ones
   it does not.
2. If — and only if — the first set is non-empty **and** you have read the target
   repository's `.commandmate/verify.yaml`, put the block in
   `proposed_issue_body`, immediately after the acceptance-criteria section, and
   record a finding that says the block was added and which ids it names.
3. Say, in the same finding, which criteria stayed prose and why. Those are for
   UAT and for a person to check.

If you did not read `.commandmate/verify.yaml`, recommend nothing and say so as a
`limitations` entry. This is not a failure state; it is the correct one.

## The block

````markdown
```acceptance-gates
version: 1
require:
  - validate
  - orchestrate-fixtures
```
````

- Exactly one block per body, or none.
- `version: 1` is the first key.
- Two-space indent, one gate id per item, no tabs, no quotes, no inline comments,
  no flow collections. A gate id matches `^[a-z0-9][a-z0-9-]{0,31}$`.
- `require:` and `gates[].id` together are capped at 32, and duplicates are an
  error.
- **No expected exit code.** A gate passes on exit 0 by definition. A criterion
  that wants a non-zero exit is rewritten as `! cmd` or `test "$(cmd)" = ...`, so
  that exit 0 is the passing case, by its author — not by a wrapper a generator
  added silently.

`cmate-issue-authoring` renders this block from code rather than by hand:

```bash
node scripts/validate-plan.mjs --render-acceptance-gates validate,orchestrate-fixtures --checkout <checkout>
```

When you are recommending a body that Skill will register, prefer to name the ids
and let it render them.

## Never invent a gate

The consuming runner refuses to infer gates from prose (ADR
`adr-issue-acceptance-gates.md` §2.3, fail-closed). **The same rule binds this
Skill**, because a prohibition that lives only on the reading side is void the
moment the writing side guesses: the Issue would carry a gate nobody approved.

| Situation | What to recommend |
|---|---|
| A criterion is decided by a gate id you read in `verify.yaml` | Put that id in `require:` |
| A criterion is measurable, but no gate runs it today | Leave it as prose. Adding the gate is a change to `verify.yaml`, i.e. separate work |
| You cannot tell whether it is measurable | Leave it as prose. Uncertainty is not a gate |
| You could not read `verify.yaml` | Recommend no block at all, and record why in `limitations` |

An id that is not declared in the worktree's `verify.yaml` stops the Issue at
dispatch, before anything is sent (`acceptance_gate_id_unknown`). A helpful guess
does not produce a stricter run; it produces a stopped one. `env-clean` is a
built-in gate that is deliberately **not** resolvable this way, so never name it.

**Do not recommend `gates:`.** Declaring a new command gate is reserved notation
that no release enforces — the planner stops on it with
`acceptance_gate_block_unsupported`. What looks like being helpful is an Issue
that cannot be dispatched.

**An Issue with no block is not a worse Issue.** Its plan and its execution
contract are byte-identical to what they were before this notation existed. A gate
nobody wrote down is a gate nobody approved, and a green nobody can trace is not
evidence.

## What to write in the result document

The recommendation uses the fields the schema already has; there is no new one.

- `proposed_issue_body` — carries the block, in the shape above, when the
  conditions in *What this Skill does with it* are met.
- `findings[]` — one entry, severity `should_fix` (or `must_fix` when the Issue
  claims a gate decides it and none does), whose locator is the acceptance-criteria
  section. State the ids, and state which criteria stayed prose.
- `open_questions[]` — when the choice of gate is a decision only the user can
  make (two plausible gates, or a gate that is expensive to run), ask. Do not pick
  one on their behalf.
- `limitations[]` — when `verify.yaml` was unreadable, or the repository declares
  no gates at all.
- `github_writes` — still `[]`. Recommending a block changes nothing about the
  read-only boundary.
