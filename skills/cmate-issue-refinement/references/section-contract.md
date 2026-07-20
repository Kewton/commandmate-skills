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
| Impact / affected files | recommended | A table of file and change, populated from evidence. |
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
