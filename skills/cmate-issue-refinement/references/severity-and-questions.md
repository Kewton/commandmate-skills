# Severity and open questions

## Severity

Severity answers one question: *can implementation start, and will the result be
verifiable?* It is not a measure of how much the wording bothers you.

### `must_fix`

Implementation cannot start, or would start from a false premise.

- An assumption about the code that the repository refutes.
- A duplicate of another Issue, with the overlap cited.
- A missing required section from the section contract.
- An acceptance criterion nobody can check.
- A stated dependency that does not exist, or an unstated one that does.
- A security-relevant change with no security section.
- A scope with no boundary, so "done" is undecidable.

Every `must_fix` carries the correction, not only the complaint. "Wrong" without
"here is what the code actually does, at `path:line`" is not a Must Fix; it is
an open question.

### `should_fix`

Implementation can start, but the result will be harder to review or to verify.

- A section present but thin, where the gap is fillable from evidence.
- Missing impact table when the affected files are known.
- A size band that the evidence contradicts.
- Test policy that names levels but no cases.
- Non-goals absent where the boundary is inferable.

### `nice_to_have`

Neither blocks nor degrades verification.

- Wording, ordering, heading consistency.
- Cross-links to related Issues.
- Additional alternatives considered.

### Rules

- One finding per problem. Do not bundle three missing sections into one entry.
- Every finding has a locator: an evidence ref, a `path:line`, or the Issue
  section it belongs to.
- Do not raise severity to get attention. An inflated Must Fix list makes the
  real ones unreadable, which is the failure mode this ranking exists to avoid.
- Do not lower severity because the fix is inconvenient.

## Open questions

An open question is something **only the user can decide**. It is not a gap you
were too lazy to research.

Before writing one, check: is the answer in the repository? If yes, it is
evidence, not a question. Is the answer a product, policy or risk-tolerance
decision, or a fact nobody has recorded anywhere? Then it is a question.

### Required form

Each open question carries:

| Field | Rule |
|---|---|
| `id` | Stable within the run: `Q-001`, `Q-002`, … |
| `question` | One sentence, answerable. Not "what about performance?" |
| `why_it_blocks` | Which section or finding stays unresolved until it is answered. |
| `options` | The alternatives you can actually see, each with its consequence. Empty is allowed when you genuinely see none. |
| `recommendation` | Optional. A recommendation is allowed; adopting it silently is not. |

### Prohibited

- Answering your own question and proceeding.
- Presenting one option as if it were the only one.
- Turning a question into a default by writing it into `proposed_issue_body`.
- Hiding a blocking question in prose instead of the `open_questions` array.

A run with unanswered blocking questions is `partial`. That is the correct
outcome, not a failure to be avoided by inventing an answer.

## Interaction with status

- Unanswered `must_fix` findings do not by themselves make a run `partial` —
  reporting them *is* the job.
- An open question that blocks a **required** section does make the run
  `partial`, because a required section is missing from the output.
