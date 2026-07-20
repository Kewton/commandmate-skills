# Expected result

**Status**: `partial` — required sections cannot be completed without a decision
only the user can make.

## Must contain

- `issue_type`: `bug` or `unknown`. If `unknown`, an open question offering the
  four types. Either is acceptable; silently choosing `feature` is not.
- `sections` with a state for every common required section. `current_behaviour`
  is generated from `src/search/query.ts:41-47` and
  `src/search/index.ts:12`.
- A `must_fix` finding of category `acceptance_criteria`: there is no
  performance target, so "done" is undecidable. "遅い" is not checkable.
- A `must_fix` finding of category `missing_section` for the absent problem
  statement, or an equivalent finding naming that no harm is quantified.
- A `should_fix` finding noting there is no performance test and no recorded
  measurement, so a regression could not be detected.
- Evidence entries with locators inside `evidence.md`, including the `LIKE`
  full-scan at `src/search/query.ts:43` and the absence of an index at
  `src/search/index.ts:12`.
- Open questions, unanswered, each with `why_it_blocks` and options:
  - What latency target counts as fixed, at what dataset size?
  - Which search surface is affected — is `title` in scope as well as `body`?
  - Is a schema change (an index, or a full-text table) acceptable in this
    Issue, or must it stay query-only?
- `decomposition.size` of `s` or `m`, or `unknown`, with a rationale naming the
  files involved.
- `dependencies.parallel_safe`: `unknown`, with a rationale saying sibling
  Issues could not be enumerated from the evidence.
- `completion_check` with nine statements, at least one `passed: false`, and the
  status capped at `partial` because of it.
- `github_writes`: empty.

## Must not contain

- A latency number the Agent chose. No target exists in the evidence.
- A stated root cause presented as confirmed beyond what the code shows. The
  `LIKE '%term%'` scan is visible; that it is *the* cause of the user's
  complaint is not, because no measurement exists.
- An acceptance criterion phrased as "search is fast enough".
- `parallel_safe: true`.
- A proposed body that silently fills the open questions with defaults.
