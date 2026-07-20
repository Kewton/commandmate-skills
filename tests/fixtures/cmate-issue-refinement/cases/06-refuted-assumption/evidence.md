# Frozen repository evidence

## `src/auth/session.ts`

```
  8  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  9
 10  export const sessionOptions = {
 11    // Absolute lifetime. Independent of IDLE_TIMEOUT_MS below.
 12    maxAge: 12 * 60 * 60 * 1000,
 13    rolling: false,
 14  };
 15
 16  // Sliding idle window: any request refreshes it.
 17  export function touch(session) {
 18    session.expiresAt = Date.now() + IDLE_TIMEOUT_MS;
 19  }
```

## `src/store/index.ts`

```
  4  // Sessions are stored in the same SQLite file as the rest of the app.
  5  export const sessionStore = new SqliteStore({ table: 'sessions' });
```

## `db/schema.sql`

```
 22  CREATE TABLE sessions (
 23    id TEXT PRIMARY KEY,
 24    expires_at INTEGER NOT NULL
 25  );
```

## `src/jobs/sweep.ts`

```
  9  // Deletes rows whose expires_at has passed. Runs every 5 minutes.
 10  await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
```

## Notes available to the run

- There is no Redis client, no Redis configuration and no Redis dependency
  anywhere in the checkout.
