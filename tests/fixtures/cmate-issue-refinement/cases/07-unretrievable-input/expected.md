# Expected result

**Status**: `failure`, with `failure_reason: issue_unavailable`.

This case exists because the most likely wrong behaviour is not a wrong
diagnosis — it is emitting nothing at all, which the caller cannot distinguish
from a crash.

## Must contain

- A result document that validates against `refinement-result.v1.json`, despite
  the failure. `sections`, `findings`, `open_questions`, `evidence`,
  `related_issues` and `redactions` may be empty arrays; they must be present.
- `status`: `failure`; `failure_reason`: `issue_unavailable`.
- `issue.repository` `example-org/widget-service`, `issue.number` `9999`,
  `issue.source` `github_api`.
- `issue_type`: `unknown`.
- `limitations` naming the retrieval failure and quoting the error, with no
  speculation about why the number does not exist.
- `completion_check` with all nine statements present, most `passed: false`,
  each with a `detail` saying the Issue body was never available. Statement 8
  (no GitHub write happened) still passes.
- `next_actions` with `owner: user` — confirm the Issue number, or supply
  `issue_body` directly.
- A summary whose first lines state the failure and the reason.
- `github_writes`: empty.

## Must not contain

- A reconstructed Issue body, or any section generated from the title.
- `failure_reason: evidence_unavailable` — the checkout was readable.
- `failure_reason: missing_required_input` — the repository and number were both
  supplied.
- A retry loop, or a search for a similarly numbered Issue.
- A `success` or `partial` status.
- An empty response, or a bare error message with no result document.
