# Section contract

Which sections an Issue must carry, and the test each one has to pass. The test
matters more than the heading: a section that exists but fails its test is
`insufficient`, not `present`.

A section is **sufficient** when an implementer who has never seen the
conversation can act on it without asking a follow-up question.

## Common sections (all types)

| Section | State | Test |
|---|---|---|
| Summary | required | One or two sentences naming what changes. A restatement of the title fails. |
| Background | required | Says why now. A reason that would have been equally true a year ago and forever fails. |
| Current behaviour | required | Describes what exists today with at least one evidence ref into the repository. |
| Problem | required | Names the concrete harm. "It is not ideal" fails. |
| Goal | required | A state that can be observed to have been reached. |
| Scope | required | An enumerated list of what this Issue changes. |
| Non-goals | required | At least one item. An empty non-goals list means the boundary was never drawn. |
| Acceptance criteria | required | Every item is checkable by a named command, a named test, or a named observation. "Works correctly" fails. |
| Security considerations | required for `feature` and `bug` | Names the trust boundary crossed, or states which boundary was checked and found not to move. |
| UX considerations | required for `feature`, recommended for `bug` | Says what the user sees and how a failure is surfaced. |
| Test policy | required | Names the cases: normal, abnormal, edge. Names the level: unit, integration, end to end. |
| Impact / affected files | required for `feature` and `bug`, recommended otherwise | A table of file and change, populated from evidence, under a heading that contains `Impact / affected files` (or one of the equivalents below). At least one row is a repository-relative path that is **not** documentation. See [Making the refined body planner-ready](#making-the-refined-body-planner-ready). |
| Dependencies | required when any exist | Issue numbers with the direction (depends on / blocks). |

## Type-specific additions

### `feature`

| Section | State | Test |
|---|---|---|
| Proposed approach | required | A direction with a named seam in the code, not a restatement of the goal. |
| Alternatives considered | recommended | At least one rejected option with the reason. |

### `bug`

| Section | State | Test |
|---|---|---|
| Reproduction steps | required | Numbered, starting from a state the reader can reach. |
| Expected behaviour | required | Stated independently of the current code. |
| Actual behaviour | required | What is observed, including the message or the wrong value. |
| Root-cause hypothesis | required | Carries a verification verdict — `confirmed`, `refuted`, `partially_confirmed` or `unverifiable`. An unverified hypothesis stated as fact is a Must Fix. |
| Regression test | required | Names the test that would have caught it. |

### `refactor`

| Section | State | Test |
|---|---|---|
| Motivation | required | The cost being paid today, with an example. |
| Before / after | required | The shape that changes, not the diff. |
| Behaviour preservation | required | Says how "no behaviour change" will be demonstrated. |

### `docs`

| Section | State | Test |
|---|---|---|
| Target documents | required | Concrete paths. |
| Change summary | required | What a reader will be able to do afterwards that they cannot do now. |

## Making the refined body planner-ready

A refined Issue is normally implemented through the cmate-orchestrate planner,
which reads **only** the number, title, body and labels. That planner raises
exactly two blocking questions, and a body that trips either one stops the Issue
from being dispatched at all:

| Blocking question | Raised when |
|---|---|
| `Acceptance criteria are unclear; add 1-3 concrete completion checks.` | No heading whose text contains `acceptance`, `criteria`, `受入`, `受け入れ`, `完了条件`, `期待結果` or `受入条件`, with `-` / `*` / `1.` list items under it. |
| `Affected files are unclear; add likely modules or paths.` | No non-documentation path survives extraction from the body. |

This is why **Impact / affected files is required for `feature` and `bug`** rather
than recommended: a run that reported `success` while leaving the planner to
block on "Affected files are unclear" was reporting a refinement nobody could act
on. The full extraction contract lives in `cmate-issue-authoring`
(`references/issue-body-contract.md`); what a refined body has to satisfy is:

1. **The affected-files heading is in the planner's deliverable vocabulary.** Any
   of `Impact / affected files`, `Affected files`, `Target files`,
   `Output files`, `Files to change|edit|create|write|add`, `成果物`,
   `対象ファイル`, `変更対象`, `変更ファイル`, `作成ファイル`, `編集対象`,
   `出力ファイル`, `生成ファイル`, or a heading containing `Deliverable`. Under
   such a heading a path is what the Issue *produces*, so it is kept whatever its
   extension.
2. **At least one row is a non-documentation path.** Outside a deliverable
   heading, anything under `docs/` and anything ending `.md` / `.rst` / `.txt`
   is classified as a reference and never reaches the planner's affected-file
   set. A `docs`-type Issue therefore cannot clear this on extension alone —
   which is exactly why the section is required for `feature` and `bug` and only
   recommended elsewhere. For a documentation deliverable, put the path under the
   deliverable heading and it counts.
3. **Paths are repository-relative and complete.** An absolute path, a `..`, a
   drive letter, or a first segment of `users` / `home` / `root` / `tmp` /
   `private` / `var` / `etc` / `proc` is discarded. A path that is a suffix of
   another path in the body (`src/lib/a.ts` beside `web/src/lib/a.ts`) is
   discarded as a partial of it — write both in full if both are meant.
4. **A path named only as evidence does not count.** Under a heading containing
   `根拠`, `出典`, `参考`, `参照`, `背景`, `関連`, `References`, `Context`,
   `Background`, `See also` or `Appendix`, a path is being cited, not claimed.
   A path that appears *only* there is excluded. The evidence refs this contract
   requires elsewhere are good practice and are **not** a substitute for the
   affected-files section — that is the trap this rule exists to close.

Acceptance criteria (already required for every type) satisfy the other blocking
question as long as they sit as list items under a heading from the vocabulary in
the table above. A criteria table is not extracted; a criteria list is.

An `acceptance-gates` block is **not** a criteria list and does not satisfy this
question: the planner strips the block out of the body before it reads any prose,
so a section that carries only the block reads as having no criteria at all. The
block goes beside the list, never instead of it
([`acceptance-gates.md`](./acceptance-gates.md)).

## Type resolution

`unknown` is a legitimate outcome. When the type is `unknown`, apply the common
sections, add an open question offering the four types, and do not add
type-specific sections. Guessing the type in order to unlock a template produces
sections nobody asked for.

## Preserving what the author wrote

- A `present` section is copied through unchanged.
- An `insufficient` section is kept and *extended*; the original wording stays,
  with the addition marked.
- A contradiction between author text and repository evidence is a finding, not
  an edit. The author decides which one is wrong.

## Evidence refs

Every generated or extended section names the evidence it rests on, by the ref
id used in the result document's `evidence` array. A section with no ref is only
acceptable when it is a pure restatement of the author's own text, and it is
marked as such.
