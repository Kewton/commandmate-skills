# Expected result

**Status**: `partial` — the duplicate has to be resolved by a human before the
Issue can be specified further.

## Must contain

- A `must_fix` finding of category `duplicate` naming `#377`, citing the
  overlapping scope: both change `src/export/formats.ts` to add a csv formatter
  and both change `src/ui/ExportButton.tsx`. The citation must reference `#377`'s
  own scope list, not its title.
- `related_issues` containing:
  - `377` — `duplicate`, with that rationale;
  - `390` — `overlapping` or `unrelated`, with a rationale that names
    `src/export/download.ts` as a different file. Filing it as `duplicate` is
    wrong.
  - `255` — `unrelated` or `overlapping` with a rationale. Filing a closed docs
    Issue as a blocker is wrong.
- `dependencies.file_conflicts` listing `src/export/formats.ts` and
  `src/ui/ExportButton.tsx` against `#377`, severity `hard` for at least
  `src/export/formats.ts` (both change the `ExportFormat` declaration at
  `src/export/formats.ts:3`).
- `dependencies.parallel_safe`: `false`, with the shared write target named.
- An open question asking which Issue survives — close `#412` as a duplicate, or
  narrow `#377` to the select UI and keep `#412` for the formatter — with the
  consequence of each.
- A `must_fix` finding of category `acceptance_criteria`: "CSV でエクスポート
  できる" names no check. A `should_fix` on the missing test policy is also
  acceptable in addition, not instead.
- `sections` marking `summary` and `proposed_approach` as `present`, preserving
  the author's wording.

## Must not contain

- A decision that `#412` is closed, or that `#377` is closed. That is the user's
  call.
- A duplicate claim resting on title similarity alone.
- `parallel_safe: true` or `unknown`.
- A merged proposed body that silently folds `#377`'s scope into `#412`.
