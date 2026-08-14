# Open questions — emit the block, never paste it

An open question is a decision only the user can make. Left in prose, it reaches
the scheduler as nothing at all: the `cmate-orchestrate` planner reads exactly one
statement of the form "the author has not decided this", and it is a fenced
` ```open-questions ` block in the Issue body. A heading is not read, on purpose.

Every other question that planner raises is an inference about an absence — it
could not find acceptance criteria, it could not find affected files — and an
inference can be wrong. This one cannot: it is the author reporting a fact only
they can report. Measured 2026-08-10 on Kewton/BorderFreeKidsMap#63, three
undecidables written under a `## 未決の問い` heading planned clean — the plan
carried no question at all, dispatch did not stop, and the worker decided them
for itself. The same three, answered and rewritten as decisions, made it
implement them and say why.

So the questions this Skill produces are worth more in a block than in a
paragraph — and putting them there is mechanical, which is what this document
settles.

**This document does not own the notation.** The source of truth is
`references/open-questions-notation.md` in `cmate-orchestrate`. The rules — the
YAML subset, the key set, the bound, what happens to a broken block — are stated
there, once. Do not restate them here and do not extend them. What is settled
here is only *which* of this Skill's open questions become a block, *how* the
string is built, and *where* it goes in the result.

The repository's conformance test
(`tests/fixtures/cmate-issue-authoring/open-questions-conformance.mjs`) renders
the block from this document's rule and feeds it to the real planner, so the
shape below is held against the reader that enforces it rather than against a
second copy of the prose.

## What this Skill does with it

It **emits**. It does not paste.

This Skill never edits an Issue ([`safety.md`](./safety.md) §2–§3): `github_writes`
stays the empty array. The block reaches GitHub only when a person puts it there.
Emitting it changes nothing about the read-only boundary — it removes the step
where a human re-types the questions into a block and drops one.

## Which questions go in

The blocking ones, and only those. This Skill already has that classification and
this document adds no second one: an open question is blocking when
`blocks_required_section` is `true`, which is the same flag that caps the run at
`partial` ([`severity-and-questions.md`](./severity-and-questions.md), *Interaction
with status*).

| `blocks_required_section` | In the block | Still in `open_questions[]` |
|---|---|---|
| `true` | yes | yes |
| `false` | no | yes |
| absent | no | yes |

State the flag on every question whenever you emit a block. Absent reads as
`false`, and a question that meant to stop the work would then stop nothing — so
the schema requires the field on every entry once `open_questions_block` is
present. Nothing is ever *removed* from `open_questions[]`: the block is a
projection of that array, not a replacement for it.

A non-blocking question is still a question. It stays in the array, it stays in
the summary, and it does not stop dispatch — which is the correct outcome for a
question that blocks nothing.

## The block

One string, fences included, ready to paste unchanged:

````markdown
```open-questions
version: 1
questions:
  - Does the coordinate conversion happen on write, or on render?
  - Is `src/legacy/topo.ts` kept, or deleted in this Issue?
```
````

Built from the blocking questions, in the order they appear in `open_questions[]`:

1. the line ` ```open-questions `;
2. `version: 1`;
3. `questions:`;
4. one line per question — two spaces, `- `, then the `question` field
   **verbatim**;
5. the closing ` ``` `, and a final newline.

Item text is the `question` field as written: no quoting, no escaping, no
re-wrapping, no trailing full stop added or removed. The contract downstream is a
copy of what the author will read, not a re-encoding of it — and a `#` or a
backtick inside a question is part of the question.

Order is `open_questions[]` order. Do not sort, and do not group.

## When a question cannot be an item

The notation's subset refuses a question that is empty, that starts with a
character YAML reserves, or that is a duplicate of another item; a question
spanning two lines is not one item at all. None of these are repaired here —
silently rewriting an author-facing sentence to fit a serializer is how the
sentence stops meaning what the run meant.

Rewrite the `question` field itself so it is one answerable sentence, and let the
block carry that same text. If you cannot, emit no block and record the reason in
`limitations`. A block that does not parse is worse than no block: the planner
refuses it with `open_question_block_invalid` and the author has to fix notation
instead of answering a question.

## More than 32

The notation caps the list at **32** questions. Past the cap, do not silently drop
the tail and do not cut a question in half. The discipline is the one
`cmate-orchestrate`'s `references/dispatch-contract.md` §2.4.1 applies when a
constraint transcription runs out of room: cut at an item boundary, then say what
was cut.

The number is written twice, here and in the runner that enforces it, so the
repository's conformance test holds the two equal. It is not a value to tune from
this side.

- Emit the first 32 blocking questions in order.
- Record a `limitations` entry naming how many were emitted, how many did not fit,
  and the `id` of every one that did not.
- Say the same thing in the summary, next to the question count.
- Treat it as evidence for [Step 6](../SKILL.md#step-6--assess-decomposition-dependencies-and-size):
  an Issue with more undecidables than the notation will carry is not an Issue
  that needs a longer block, it is one that needs splitting.

## What to write in the result document

- `open_questions_block` — the string above, when at least one question is
  blocking. Omit the field entirely when none is: a block that asks nothing is
  refused by the planner, and an empty one would announce a stop and then name no
  reason for it.
- `open_questions[]` — unchanged, every question, blocking or not. The block is
  derived from it and never replaces it.
- `proposed_issue_body` — when the run emits one, it carries the same block, the
  same bytes, once, at the end. A proposed body that answers nothing and says
  nothing about what is unanswered is the body that plans clean; that is the
  failure this notation exists to remove.
- `limitations[]` — when questions did not fit the bound, or when no block could
  be built at all.
- `github_writes` — still `[]`.

## Deleting the block is the record of the decision

Say this in the summary's next action, because it is the half a reader does not
guess: the block stays in the body until the questions are answered, and
**deleting it is what records that they were**. Answering in the body while
leaving the block behind keeps the Issue stopped; deleting it while leaving the
questions unanswered puts the decision back on the worker, which is where it
started.
