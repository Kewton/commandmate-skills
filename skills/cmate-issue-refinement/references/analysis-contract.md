# Decomposition, dependency and size assessment

Every judgement here needs a stated rationale that names evidence. A size band
with no rationale is a guess wearing a label.

## Size bands

| Band | Rough effort | Signal |
|---|---|---|
| `xs` | under half a day | One file, no interface change, no new test file. |
| `s` | half a day to a day | One module, an existing seam, tests extend an existing suite. |
| `m` | one to three days | Several modules in one layer, or one vertical slice with new tests. |
| `l` | three to five days | Crosses layers, or changes a published interface. Recommend a split. |
| `xl` | over a week | Must be split. Do not estimate further; enumerate the slices. |

Bands are about the *change*, not about the writer's confidence. When evidence
is thin, say `unknown` and record what would settle it.

## Split rules

Recommend `split` when any of these holds:

- the band is `l` or `xl`;
- the Issue contains two goals that could ship in either order;
- part of the work is blocked and part is not;
- two parts have different reviewers or different risk levels.

When recommending a split, produce child slices that are each **vertical**: a
slice ships an observable change end to end. Do not slice by phase
(design / implement / test) — a design-only slice cannot be verified and cannot
be reverted independently.

Each child slice carries: a title, a one-line scope, its own band, its
dependencies, and the acceptance criterion that proves it landed.

When *not* splitting, say why the Issue stays one unit. "Small enough" is
acceptable only with the band and the file count that support it.

**The recommendation is where this Skill stops.** `decomposition.children` is a
proposal, not a registration: this Skill never opens an Issue. Handing those
children to `cmate-issue-authoring` is what turns them into real Issues, in
dependency order, under explicit approval. That package does not re-cut the
slices, and this one does not register them — the boundary is exactly whether a
GitHub Issue gets created.

## Dependencies

Record two directions separately:

- `depends_on` — this Issue cannot start, or cannot be verified, until the other
  lands. Say which of the two it is.
- `blocks` — the other Issue is waiting on this one.

Each entry needs the reason: a shared interface, a shared file, an ordering
constraint in a migration, or a review gate. An Issue number with no reason is
not a dependency; it is a note.

Do not infer a dependency from topic similarity. Two Issues about the same
feature area are frequently independent.

## File conflicts

List the files that this Issue and a sibling Issue would both modify. Base the
list on evidence — files you found while reading — not on prediction.

Distinguish:

- **hard conflict** — both change the same function or the same declaration;
- **soft conflict** — both change the same file in different regions;
- **none found** — you looked and found nothing.

"None found" is not the same as "no conflict exists". Say which one you mean.

## Parallel safety

`parallel_safe` takes one of three values:

| Value | Meaning |
|---|---|
| `true` | You enumerated the sibling Issues, compared write targets, and found no shared one. |
| `false` | You found a shared write target, or an ordering constraint. Name it. |
| `unknown` | You could not enumerate the siblings, or could not read the relevant files. |

Never report `true` because nothing came up. Absence of evidence is `unknown`.

## Ordering advice

When more than one Issue is in play, state a recommended order and the single
reason for it — usually the interface that has to exist first. Keep the reason
to one sentence. A long ordering argument usually means the split is wrong.

## Vocabulary shared with cmate-issue-authoring

The two packages describe the same three concepts with different value sets.
They have **not** been collapsed onto one set: both result contracts are
published as v1, and changing a value domain retroactively invalidates documents
already emitted under it. The mapping below is the normative one. Convert with
it; do not invent a conversion at the point of handoff.

| Concept | Here | cmate-issue-authoring | Mapping |
|---|---|---|---|
| Size | `decomposition.size`, `decomposition.children[].size`: `xs` / `s` / `m` / `l` / `xl` / `unknown` | `issues[].size`: `xs` / `s` / `m` / `l` | Same bands, same meanings. `xl` and `unknown` have no counterpart (below). |
| Parallel safety | `dependencies.parallel_safe`: `true` / `false` / `"unknown"` | `issues[].parallel_safe`: `yes` / `no` / `unknown` | `true` ≡ `yes`, `false` ≡ `no`, `"unknown"` ≡ `unknown`. One-to-one. |
| Relation to another Issue | `related_issues[].relation`: `duplicate` / `overlapping` / `depends_on` / `blocks` / `unrelated` | `duplicate_suspicions[].verdict`: `duplicate` / `overlapping` / `unrelated` | The three shared values are the same judgement. `depends_on` and `blocks` are not duplicate verdicts; they become edges in that package's `issues[].depends_on`. |

Notes.

- **`xl` and `unknown` are ours alone.** `xl` means "do not estimate further,
  enumerate the slices" and `unknown` means "the evidence would not settle the
  band" — both are assessments of an Issue that already exists. The other package
  emits slices it has just cut, so either value there would only say the split is
  unfinished. The narrower domain is a constraint, not an omission.
- **`parallel_safe` is a mixed-type enum here** (two booleans and one string)
  and a three-value string enum there. The uniform string enum is the better
  contract; this one is published and stays as it is. Convert explicitly at the
  boundary, and keep `unknown` meaning what it means in both: absence of evidence
  is never `true`.
- **`relation` is wider than a duplicate verdict.** Three of its five values
  answer "is this the same work?"; the other two answer "which one goes first?".
  A candidate marked `depends_on` or `blocks` must be handed over as a
  dependency, never as a duplicate suspicion — the receiving package's
  `verdict` has no room for a direction, on purpose.
