# Frozen repository evidence

This is the entire checkout available for this case.

## `src/search/query.ts`

```
 41  export async function search(term: string, limit = 50) {
 42    const rows = await db.all(
 43      'SELECT id, title, body FROM documents WHERE body LIKE ?',
 44      [`%${term}%`],
 45    );
 46    return rows.slice(0, limit);
 47  }
```

## `src/search/index.ts`

```
 12  // No index is created on documents.body.
 13  export { search } from './query';
```

## `db/schema.sql`

```
  7  CREATE TABLE documents (
  8    id INTEGER PRIMARY KEY,
  9    title TEXT NOT NULL,
 10    body TEXT NOT NULL
 11  );
```

## `tests/search.test.ts`

```
  9  it('returns matching documents', async () => {
 10    expect(await search('alpha')).toHaveLength(2);
 11  });
```

## Notes available to the run

- There is no performance test, and no recorded latency measurement anywhere in
  the checkout.
- There is no issue tracker export, so no other Issue can be compared.
