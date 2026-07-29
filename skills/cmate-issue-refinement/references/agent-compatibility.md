# Agent compatibility and fallback

The procedure in `SKILL.md` names capabilities, not tools. Each Agent maps them
to whatever it has. Where an Agent has no equivalent, it uses the fallback and
records the substitution in `limitations` — the result stays comparable across
Agents because the vocabulary does not change.

## Capabilities the procedure needs

| Capability | Used for | Fallback when unavailable |
|---|---|---|
| Read a file in the checkout | Evidence gathering | Ask the caller to paste the region; mark the evidence `caller_supplied` |
| Search the checkout by pattern | Finding the seam a claim rests on | Read the directory listing and open candidates by name |
| Run a read-only shell command | `gh issue view`, read-only version-control queries | Accept `issue_body` from the caller; set `issue.source` to `caller_supplied` |
| Ask the user a structured question | Issue type when undecidable | Emit the question in `open_questions` and finish with `partial` |
| Emit long structured output | The result document | Emit the document first, summary second; never truncate the document to fit the summary |

Asking the user is **optional** everywhere. An Agent that cannot ask
interactively is never blocked: an unasked question becomes an
`open_questions` entry, and the run ends `partial`. That is the designed
degradation, not a failure.

## Recorded support

| Agent | Support | What that is based on |
|---|---|---|
| `claude` | native | Claude Code 2.1.220, measured 2026-07-26: discovers `SKILL.md` from `.claude/skills` — not `.agents/skills` — and matches in the slash palette. The procedure uses no Claude-specific tool name. |
| `codex` | native | Codex CLI 0.145.0, measured 2026-07-26: reads `SKILL.md` from `.agents/skills` (model self-report, not a mechanical trace). That version exposes no skill as a slash command, so invoke it by name. |
| `gemini` | unknown | Not measured. |
| `opencode` | unknown | Not measured. |

`support` records the **discovery path**, which the installer decides: since
CommandMate 0.15.0 a package is written to `.agents/skills/<skill-id>/` and
`.claude/skills/<skill-id>/` byte-identically, so the measurement above holds for
any package. It does **not** record how well this procedure performs on an Agent —
no rubric evaluation has been recorded for Codex yet (see below).

`unknown` is deliberate. Declaring `native` for an Agent nobody has measured would
make the manifest's compatibility block unusable for the decision it exists to
support. When a measurement is recorded, the entry moves to `native` or
`commandmate_runtime` and the Skill version is bumped.

## Opt-in evaluation

Evaluation is manual and opt-in; nothing in this package runs it automatically,
and no fixture makes a network call.

1. Install the Skill into a checkout and open a session with the Agent under
   test.
2. For each case in `tests/fixtures/cmate-issue-refinement/cases/`, give the
   Agent the case's `issue.md` and `evidence.md` as the Issue body and the
   repository evidence, with `write_mode: read_only`.
3. Score the response against the case's `expected.md` using
   `tests/fixtures/cmate-issue-refinement/rubric.md`.
4. Record the Agent name, its exact version string, the date, and the score.

Record the outcome even when it is bad. An evaluation that only gets written
down when it passes measures nothing.

## What does not vary by Agent

The safety rules, the section contract, the severity definitions, the result
schema and the completion check are identical for every Agent. An Agent that
cannot satisfy one of them reports `partial` — it does not substitute a weaker
rule.
