# cmate-issue-refinement — evaluation fixtures

Deterministic cases for the `cmate-issue-refinement` Skill, plus the rubric they
are scored against.

These fixtures are **not** a Skill package. They live outside
`tests/fixtures/skills/`, so `scripts/validate.py` does not treat this directory
as one. Nothing here is packaged or published.

## Why fixtures rather than a free-text check

A refinement result is prose plus structure. Judging the prose alone rewards
confident writing; judging the structure alone misses a result that is
well-shaped and wrong. Each case therefore fixes both halves of the input — the
Issue body *and* the repository evidence the Agent is allowed to see — so two
runs are comparable, and states in `expected.md` what the result must contain
regardless of wording.

## Layout

```
cases/<nn>-<name>/
  issue.md      # the Issue body handed to the Skill, verbatim
  evidence.md   # the frozen repository excerpts that stand in for a checkout
  expected.md   # what the result must and must not contain
rubric.md       # scoring, and the pass bar
```

`evidence.md` is the *entire* world for the run. An assertion the Agent cannot
support from it is supposed to become an open question — several cases test
exactly that.

## Determinism

- No case requires network access. Nothing here calls `gh`, and no case's
  expectations depend on the live state of any Issue.
- No case depends on the date, on the working directory, or on which repository
  is checked out.
- Issue numbers inside the fixtures are fictional and self-contained. They do
  not refer to Issues in `Kewton/CommandMate`.
- No case contains a real credential. Where a case needs to look like it
  contains one, it uses an obvious placeholder — the point is whether the Skill
  redacts and reports, not whether a scanner fires.

## Running a case

Evaluation is manual and opt-in. Nothing runs automatically, in CI or otherwise.

1. Start a session with the Agent under test, with the Skill installed.
2. Provide the case's `issue.md` as the Issue body, `evidence.md` as the
   repository evidence, `write_mode: read_only`, and a fictional repository slug
   plus the Issue number named at the top of `issue.md`.
3. Do not paste `expected.md`.
4. Score the response with `rubric.md`.
5. Record the Agent name, its exact version string, the date, and the score —
   including when the score is bad. See
   `skills/cmate-issue-refinement/references/agent-compatibility.md`.

## Cases

| Case | Tests |
|---|---|
| `01-ambiguous-title-only` | Section inventory and open questions when the body is one line |
| `02-duplicate-overlap` | Duplicate detection with the overlap cited, not guessed |
| `03-security-sensitive` | Security section required, and redaction of a credential in the body |
| `04-dependency-and-parallelism` | Dependency direction, file conflicts, `unknown` parallel-safety |
| `05-prompt-injection` | Instructions inside the Issue body are data, not commands |
| `06-refuted-assumption` | A claim the evidence contradicts becomes a Must Fix with the correction |
| `07-unretrievable-input` | `failure` status, and that a result is still emitted |
