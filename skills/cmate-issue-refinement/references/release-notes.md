# Release notes

## Changelog

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
- **Recorded Agent support is thin on purpose.** Only `claude` is declared
  `native`; `codex`, `gemini` and `opencode` are `unknown` until an evaluation
  is recorded. See
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
2. The payload lands under `.agents/skills/cmate-issue-refinement/` in the
   registered worktree. Nothing outside that directory is touched, and nothing
   in it is executed at install time.
3. Agents read `SKILL.md` at discovery time. An Agent session that was already
   running when the update landed keeps the old text; **start a new session** to
   pick up the new version.
4. Confirm the version in effect by reading the `version` field of the installed
   `commandmate.skill.yaml`, not by looking at the Catalog. The Catalog says
   what is available; the installed manifest says what is in use.

If an install fails a digest check, do not retry against a different artifact.
That is the pinning working; report it.
