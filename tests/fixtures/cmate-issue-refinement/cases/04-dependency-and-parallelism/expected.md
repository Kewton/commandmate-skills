# Expected result

**Status**: `partial` — the compatibility promise is a user decision.

## Must contain

- `decomposition.recommendation`: `split`, with `size` of `l` or `xl` and a
  rationale naming the layers crossed: schema, API contract, UI, export,
  webhook.
- `decomposition.children` that are **vertical** slices, each with its own
  acceptance criterion. A slice per layer named "schema change", "API change",
  "UI change" in that order is acceptable only if each is independently
  shippable and says so; slices named "設計" / "実装" / "テスト" are wrong and
  cap R5 at 0.
- The migration and the schema change identified as the ordering constraint:
  every other slice `depends_on` it, with `kind: cannot_start`, citing
  `db/schema.sql:14-17`.
- `dependencies.file_conflicts`:
  - `src/inventory/update.ts` against `#455`, severity `hard` — both change
    `updateInventory`, at `src/inventory/update.ts:31-35`;
  - `src/export/formats.ts` against `#412`, severity `soft` — `#412` adds a
    formatter, `#501` changes a column, in the same file.
- `dependencies.parallel_safe`: `false`, with `src/inventory/update.ts` named as
  the shared write target. `unknown` is wrong here: the sibling scopes were
  provided.
- A `must_fix` finding of category `scope` or `acceptance_criteria`:
  `docs/api/v1.md:40-41` records that two partners consume `{ sku, quantity }`
  in production, so the Issue is proposing a breaking API change without a
  compatibility plan.
- A `must_fix` on "既存データが移行されている" — no conversion is stated.
  Individual counts cannot be converted to grams without a per-sku unit weight,
  and no such data exists in `db/schema.sql:14-17`.
- Open questions, unanswered:
  - Where does per-sku unit weight come from, given the schema has none?
  - Is the `/api/v1` response allowed to change in place, or does this need a
    `v2` or a dual-field transition?
  - Is `#455` sequenced before or after this Issue, given both rewrite
    `updateInventory`?

## Must not contain

- `parallel_safe: true` or `unknown`.
- A migration described as mechanical, or a conversion factor the Agent chose.
- A recommendation to keep the Issue as one unit.
- A dependency on `#412` asserted as `hard` — the file is shared but the
  declarations are not.
