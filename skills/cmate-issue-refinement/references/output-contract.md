# Output contract

Two artifacts, always both, in this order: the result document, then the
human-readable summary. The summary is a rendering of the document — it never
carries a claim the document does not.

## The result document

One JSON object valid against
[`../schemas/refinement-result.v1.json`](../schemas/refinement-result.v1.json).

`result_schema_version` is `1`. It is the version of *this contract*, not of the
Skill. A later Skill version that changes the field set raises it and keeps
reading version 1 documents.

### Status

Exactly one of `success`, `partial`, `failure`.

| Status | Every one of these holds |
|---|---|
| `success` | Every required section has a state; every generated section has an evidence ref; every stated assumption has a verdict; every completion-check statement passed; no open question blocks a required section; no step was refused or skipped. |
| `partial` | A result was produced, but at least one of the above fails. `limitations` says which, and why. |
| `failure` | No usable refinement was produced. `failure_reason` is set. `findings`, `open_questions` and `evidence` may be empty. |

`failure_reason` is one of:

| Value | When |
|---|---|
| `missing_required_input` | Repository or Issue number unavailable. |
| `issue_unavailable` | The Issue could not be retrieved read-only. |
| `evidence_unavailable` | The checkout could not be read at all. |
| `safety_refusal` | A safety rule stopped the run outright. |
| `schema_violation` | The document could not be made valid; emit it anyway with this reason. |
| `internal_error` | Anything else. Say what, in `limitations`. |

A `failure` still emits both artifacts. A run that produces nothing is
indistinguishable from a crash, and the caller has to be able to tell.

### Field notes

- `skill_version` is the version from `commandmate.skill.yaml`. Copy it; do not
  invent it.
- `issue.source` is `github_api` or `caller_supplied`. It decides how much of
  the body was under the caller's control.
- `evidence[].locator` is `path:line` or `path:start-end`, relative to the
  repository root. Never an absolute path.
- `sections[].evidence_refs` holds `evidence[].ref` values. A generated section
  with an empty array is a schema-valid document and a failed completion check.
- `assumptions[].verdict` is `confirmed`, `refuted`, `partially_confirmed` or
  `unverifiable`. `refuted` requires `correction`.
- `decomposition.recommendation` is `keep_single` or `split`. `split` requires a
  non-empty `children`.
- `dependencies.parallel_safe` is `true`, `false` or `unknown` — the string
  `"unknown"`, not a missing field.
- `proposed_issue_body` is a proposal. Its presence is never permission to apply
  it.
- `redactions` carries kind and count only, never the value.
- `github_writes` is always the empty array. It exists so a consumer can assert
  emptiness instead of inferring it from silence.
- `completion_check` mirrors the nine statements in `SKILL.md`, each with
  `passed` and, when false, `detail`.

## The summary

Markdown, addressed to a person deciding what to do next. Same vocabulary as the
document; no numbers that are not in it.

```markdown
## Issue refinement: <repository>#<number> — <status>

**Type**: <issue_type>  |  **Size**: <band>  |  **Split**: <keep_single|split>
**Parallel-safe**: <true|false|unknown>  |  **GitHub writes**: none

### What changed in the proposal
- <section>: <present|extended|generated>

### Must fix (<n>)
1. <title> — <one line> (<locator>)

### Should fix (<n>) / Nice to have (<n>)
- <title> — <one line>

### Open questions (<n>) — answer these before implementation
1. <question>
   - blocks: <section or finding>
   - options: <a> / <b>

### Evidence
- <ref> <locator> — <note>

### Completion check
- [x] <statement>
- [ ] <statement> — <why it failed>

### Limitations
- <what was not done, and the rule or gap that stopped it>

### Next action
<who> <does what>. This Skill made no change to the Issue.
```

Rules:

- Counts in headings match array lengths in the document.
- The "GitHub writes: none" line is not optional. A reader must be able to see,
  without opening the document, that nothing was mutated.
- When status is `partial` or `failure`, the reason appears in the first three
  lines, not buried under Limitations.
- Never end with an unqualified "done". End with the next action and its owner.

## Completion check

Run it before reporting, and report it either way. The statements are the nine
in `SKILL.md`. A statement that cannot be evaluated is `passed: false` with the
reason — not omitted.

A failed statement caps the status at `partial`. Reporting a `success` beside a
failed statement is the single worst outcome this contract exists to prevent.
