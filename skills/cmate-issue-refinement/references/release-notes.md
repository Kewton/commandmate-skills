# Release notes

## Changelog

### 0.3.0 — recommend the acceptance-gates block, never write it (Issue #124)

- **This Skill now knows the `acceptance-gates` notation** and recommends a block
  when some acceptance criterion is decided by a gate that already exists in the
  target repository's `.commandmate/verify.yaml`. New reference:
  [`acceptance-gates.md`](./acceptance-gates.md). The notation's source of truth
  is `cmate-orchestrate`'s `references/acceptance-gates-notation.md`; this package
  mirrors it and does not extend it.
- **The read-only boundary is unchanged, and that is the point.** The block goes
  into `proposed_issue_body` and a finding — a proposal a person applies. This
  Skill still edits no Issue, `github_writes` is still always `[]`, and no new
  permission is declared. Recommending is the whole of its part; registering an
  Issue whose body carries a block is `cmate-issue-authoring`.
- **It may not invent a gate.** The consuming runner refuses to infer gates from
  prose (fail-closed, ADR §2.3), and that prohibition is void if the writing side
  guesses instead: an id that is not declared in the worktree's `verify.yaml`
  stops the Issue at dispatch, before anything is sent. So: read `verify.yaml` or
  recommend nothing; leave anything you cannot tell is measurable as prose; never
  recommend `gates:`, which no release enforces.
- **A block is not a criteria list.** The planner strips the block out of the body
  before reading any prose, so a section carrying only the block reads as having
  no acceptance criteria at all and is blocked downstream.
  [`section-contract.md`](./section-contract.md) now says so where the
  planner-ready rules are stated.
- Completion check goes from nine statements to **ten**; the tenth is the
  discipline above, and a run that recommended no block passes it.
- `result_schema_version` stays 1 and the schema is unchanged: the recommendation
  uses `proposed_issue_body`, `findings`, `open_questions` and `limitations`,
  which already exist. A document produced by 0.2.1 is still valid.
- The shape of every block shipped in this package is held byte-identical to the
  notation's own example by
  `tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs`, which
  the repository's CI runs.

### 0.2.1 — the rules live in the references; `SKILL.md` points at them (Issue #68)

- `SKILL.md` now settles only four things — when to use the Skill, how to call
  it, how to read the result, and where it stops — and no longer restates rules
  that the references, the schema or the manifest already carry. **Nothing was
  removed from a reference or from the schema.** No rule, no field, no status
  condition and no result-document compatibility changed.
- Removed from `SKILL.md`: the *Boundaries* section in full (it repeated
  [`safety.md`](./safety.md) §1–§5), the prohibition list under *Permissions*
  (same, plus the manifest's `declared_permissions`, which declares no write at
  all), the failure-behaviour table (status and `failure_reason` are settled by
  [`output-contract.md`](./output-contract.md)), and the per-step restatements of
  the section states, the size bands, the `parallel_safe` rule and the severity
  definitions.
- **The nine completion-check statements moved into
  [`output-contract.md`](./output-contract.md)**, which already claimed to mirror
  them. They existed nowhere else, so they were moved rather than dropped, and
  the field note now points at the list instead of back at `SKILL.md`.
- The pair boundary with `cmate-issue-authoring` (When-to-use, Step 6 and the
  handoff), the Step 1 note that comments are not input, and the
  Impact / affected files requirement are unchanged: they are load-bearing.
- The `description` is 148 characters, already under 200, so it was not touched.

### 0.2.0 — a two-way boundary with cmate-issue-authoring, and planner-ready output (Issue #65)

- **The pair boundary is now stated on both sides.** `cmate-issue-authoring`
  already pointed here for "refine an existing Issue"; nothing here pointed back.
  The description, the When-to-use section and Step 6 now say what belongs to
  that package and why.
- **Splitting is divided along one line: recommending is this Skill, registering
  is `cmate-issue-authoring`.** Both packages used to claim "splitting an Issue
  that is too big". `decomposition.children` is a proposal; opening the child
  Issues is the other package's step, and it does not re-cut what is proposed
  here.
- **Impact / affected files is now required for `feature` and `bug`** (it was
  *recommended*). A refined Issue is normally implemented through the
  cmate-orchestrate planner, which blocks with "Affected files are unclear" when
  no non-documentation path survives extraction from the body — so a `success`
  here could still produce an Issue nobody could dispatch. `section-contract.md`
  now carries the heading vocabulary and the path rules the extraction applies,
  and completion-check statement 2 names the section.
- **The vocabulary shared with `cmate-issue-authoring` is mapped explicitly**
  (`analysis-contract.md`, and the schema's own `description` fields): size
  bands, `parallel_safe` (`true`≡`yes`, `false`≡`no`, `"unknown"`≡`unknown`) and
  the relation values (`depends_on` / `blocks` are dependencies, not duplicate
  verdicts). The value sets were **not** collapsed onto one: both result
  contracts are published as v1, and changing a value domain retroactively
  invalidates documents already emitted under it. No field's value set changed.
- **The relation to CommandMate's own commands moved out of this changelog and
  into `SKILL.md`**, where it is read: this Skill is `/issue-enhance` plus the
  recommendation half of `/issue-split`; `/issue-create` and the registering half
  of `/issue-split` are `cmate-issue-authoring`.
- The description is now Japanese and under 200 characters, symmetric with
  `cmate-issue-authoring`'s: what it does, when, and which package to use
  otherwise. The body of `SKILL.md` stays English.

### 0.1.2 — state that comments are not input (Issue #45 / CommandMate #1678 B-3)

- Step 1 now states explicitly that Issue comments are read neither here nor by
  the downstream cmate-orchestrate planner (which fetches only number, title,
  body and labels), so a decision that lives only in a comment never reaches the
  execution contract a worker receives. Settled decisions must be folded into
  the Issue **body**; a body left on the old plan is the plan that gets
  implemented.

### 0.1.0 — initial release

- First official packaging of the Issue refinement procedure as an Agent Skill.
  Reconstructed from CommandMate's internal `issue-enhance`, `issue-split` and
  `multi-stage-issue-review` command prose; Agent-specific tool names, report
  directory layout and sub-agent delegation were removed rather than translated.
- Defines the inputs, the permissions used, the per-step stop conditions, the
  failure behaviour and the completion check explicitly, so the procedure does
  not depend on which Agent runs it.
- Adds a versioned result document (`result_schema_version: 1`) with
  `success` / `partial` / `failure`, plus a human-readable summary rendered from
  it.
- Adds a section contract per Issue type, severity definitions, and a rule that
  questions only the user can answer stay unanswered.
- Adds a decomposition, dependency, file-conflict and parallel-safety assessment
  where `unknown` is a first-class answer.
- GitHub access is read-only. There is no code path in this package that writes
  to an Issue.
- Ships instruction text only: no scripts, no executables, no install-time
  hooks.

This text is the source for the annotated tag message that becomes the Catalog
`changelog` entry for this version.

## Expected effect

- An Issue that arrives as a title leaves with background, current behaviour,
  problem, goal, scope, non-goals, security, UX, test policy and checkable
  acceptance criteria — or with an explicit, enumerated list of what is still
  missing and why.
- Claims the Issue makes about the code are checked against the code before
  anyone implements against them.
- Duplicate and overlapping work is surfaced with the overlap cited, not
  guessed from a similar title.
- Size, dependencies and parallel-safety come with a rationale, so a scheduler
  can act on them.
- Two different Agents produce results in the same vocabulary, comparable field
  by field.

## Constraints

- **Read-only.** It never edits, comments on, labels or closes an Issue.
  Applying a proposed body is a separate action the user approves after seeing
  the diff.
- **No outbound fetches.** URLs found in an Issue body are recorded, never
  opened.
- **Evidence is limited to the checkout.** A claim that can only be settled by
  running a build or a test becomes an open question, not a command.
- **It does not decide for the user.** Product, policy and risk-tolerance
  questions come back as questions. A run with unanswered blocking questions
  ends `partial` by design.
- **Recorded Agent support is thin on purpose.** `claude` and `codex` are
  declared `native` on a 2026-07-26 discovery measurement; `gemini` and
  `opencode` stay `unknown` until one is recorded. Discovery is not a quality
  claim — no rubric evaluation has been recorded for Codex. See
  [`agent-compatibility.md`](./agent-compatibility.md).
- **Quality is not self-certifying.** The fixtures and rubric under
  `tests/fixtures/cmate-issue-refinement/` are the check; a good-looking
  free-text answer is not evidence that the procedure held.

## How to reload after an update

A published version is immutable, so an update is always a new version, never
new bytes behind the same one.

1. Install the new version through CommandMate's Skill install flow. The exact
   UI and CLI wording belongs to CommandMate and is not restated here; what
   matters is that install pins to the Catalog's artifact digest and shows the
   permission and risk declarations before applying.
2. The payload lands under both `.agents/skills/cmate-issue-refinement/` and
   `.claude/skills/cmate-issue-refinement/` in the registered worktree, written
   byte-identically (CommandMate 0.15.0 and later; the install receipt records
   both roots). Nothing outside those directories is touched, and nothing in
   them is executed at install time.
3. Agents read `SKILL.md` at discovery time. An Agent session that was already
   running when the update landed keeps the old text; **start a new session** to
   pick up the new version.
4. Confirm the version in effect by reading the `version` field of the installed
   `commandmate.skill.yaml`, not by looking at the Catalog. The Catalog says
   what is available; the installed manifest says what is in use.

If an install fails a digest check, do not retry against a different artifact.
That is the pinning working; report it.
