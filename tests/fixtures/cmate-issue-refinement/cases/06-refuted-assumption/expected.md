# Expected result

**Status**: `partial` — the corrected facts change what the Issue is asking for,
and the new target is a user decision.

## Must contain

- `assumptions` with at least three entries and an explicit verdict on each:
  - "maxAge が 30 分にハードコードされている" → `refuted`. `correction`:
    `maxAge` is 12 hours at `src/auth/session.ts:12`; the 30-minute value is
    `IDLE_TIMEOUT_MS` at `src/auth/session.ts:8`, a *sliding idle* window
    applied by `touch()` at `src/auth/session.ts:17-19`. The two are
    independent.
  - "Redis の TTL も同じ値" → `refuted`. `correction`: there is no Redis.
    Sessions are in SQLite via `src/store/index.ts:4-5`, with expiry enforced by
    the sweep job at `src/jobs/sweep.ts:9-10`.
  - "作業中にログアウトされる" → `unverifiable` or `partially_confirmed`. The
    idle window explains logout during *inactivity*; nothing in the evidence
    shows logout during active work. Marking it `confirmed` is wrong.
- A `must_fix` finding of category `refuted_assumption` for each refutation,
  each carrying the correction and the locator. A single bundled finding for
  both is wrong — the rule is one finding per problem.
- A `must_fix` of category `scope`: the stated fix ("maxAge と Redis TTL を 8
  時間に") does not correspond to the code. Changing `maxAge` from 12 hours to 8
  would *shorten* the absolute lifetime, which is the opposite of the intent.
- A `should_fix` noting `rolling: false` at `src/auth/session.ts:13`, since it
  bears directly on whether activity extends the session.
- Open questions, unanswered:
  - Is the intent to lengthen the idle window, remove it, or make it rolling?
  - What absolute lifetime is acceptable, given the security trade-off of a long
    one?
- A `must_fix` on the acceptance criterion: "8 時間ログインが維持される" is not
  checkable without stating whether the user is active during those 8 hours.
- `sections` preserving the author's reproduction narrative rather than
  replacing it, with the corrections recorded as findings.

## Must not contain

- Any statement that Redis exists, or a proposed Redis TTL change.
- A chosen timeout value presented as the decision.
- A proposed body that quietly rewrites the root-cause section as if the author
  had written the corrected version.
- `success` status. Refuted assumptions plus unanswered blocking questions
  cannot be `success`.
