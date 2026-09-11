# tests/fixtures/cmate-delegate

Regression suite for the `cmate-delegate` package.

```bash
bash tests/fixtures/cmate-delegate/run_tests.sh
```

No network, no CommandMate server, no `npm install`: the `commandmate` the suite
puts on `PATH` is a stub that records every call and refuses any subcommand the
package is not allowed to reach.

| file | what it holds |
|---|---|
| `run_tests.sh` | the suite. Prints `ok` / `FAIL` per case and exits 1 on any failure |
| `check-brief.sh` | the checker for `references/delegation-brief.md`: the five required fields in the ja block, the en block and the key table, plus the `DONE:` closing marker |

## What is proved

1. **The request template still asks for everything a request needs.** Purpose,
   target, output shape, what not to touch, how to close — in both languages,
   and the key column that the CommandMate side is to be reconciled against
   ([CommandMate#2376](https://github.com/Kewton/CommandMate/issues/2376)).
2. **`check-brief.sh` is not a rubber stamp.** Each field is deleted from a copy
   of the real file and the checker has to name that deletion. 14 mutations.
3. **`ask.sh` passes `wait`'s exit code through** — 0 / 10 / 21 / 99 / 124 —
   including when the trailing `capture` succeeds (which is exactly how a
   timeout gets reported as a finished delegation) and when it fails.
   stdout stays the reply and nothing else.
4. **No branch of `ask.sh` answers for the other session.** Every `wait` outcome
   is driven and the stub's call log has to stay free of `respond`, `auto-yes`
   and `interrupt`; the shipped scripts are then read statically for the same.
5. **SKILL.md section 8 teaches the relay ledger, not its absence.** The
   section bounded by `## 8.` / `## 9.` has to carry `commandmate relays`,
   `relays cancel`, both asynchronous forms and the four refusals (chain,
   3 hops, one open relay per pair, 24h), and must not declare the CLI unbuilt
   ([#243](https://github.com/Kewton/commandmate-skills/issues/243),
   [CommandMate#2377](https://github.com/Kewton/CommandMate/issues/2377)).
   10 more mutations, plus a guard that fails if the two headings move so the
   extraction can never be vacuously green.

## Not proved here

- That an Agent actually follows `SKILL.md`. That is a rubric measurement on a
  real session pair, and it is unmeasured for every Agent
  (`references/agent-compatibility.md` section 3).
- The live `0` / `10` / `124` paths against a real CommandMate server. The stub
  fixes the wrapper's behaviour given those codes; where the codes themselves
  come from is recorded in `references/exit-codes.md` section 5.
- The live `commandmate ask` / `whoami` / `peers` / `relays` / `--reply-to`
  paths. The suite covers the branch that detects them and, for section 8, the
  text that teaches them — not the commands themselves. Whether a given CLI
  build has them is a runtime check, not a version comparison
  (`references/agent-compatibility.md` section 3).
