# tests/fixtures/cmate-handoff

Regression suite for the `cmate-handoff` package.

```bash
bash tests/fixtures/cmate-handoff/run_tests.sh
```

No network, no CommandMate server, no `npm install`: the `commandmate` the suite
puts on `PATH` is a stub that records every call and refuses any subcommand
other than `mem` and `brief`.

The package ships no script. Its runnable part is the fenced `bash` blocks in
`SKILL.md`, so the suite extracts them and runs them as they are written.

| file | what it holds |
|---|---|
| `run_tests.sh` | the suite. Prints `ok` / `FAIL` per case and exits 1 on any failure |

## What is proved

1. **Purpose and what-not-to-write come first** (the acceptance criterion
   CommandMate#4228 added on 2026-11-09). The first two `## ` headings of
   `SKILL.md` are「何のための記憶か」and「書かないもの」, they precede section 3,
   the first fenced block and the first `--kind`, and each carries its literals.
2. **That check is not a rubber stamp.** The two sections moved after section
   4, the heading renamed, a `--kind` rule placed above them, and every literal
   deleted one at a time: each is reported.
3. **The entry gate says "use" only for mode `on`.** The first block of
   `SKILL.md` runs against `mem mode --json` answering on / off / derived /
   unknown command (a CLI without `mem`) / server not running / non-zero exit
   with "on" on stdout.
4. **The three-way control.** All blocks run in order behind the gate. Mode on:
   each guarded block makes one call. Mode off and no `mem`: the log holds
   `mem mode --json` and nothing else. Every block after the gate is wrapped in
   `if [ "${MEM}" = on ]; then … fi`.
5. **The gate and the guards are not rubber stamps.** A grep loosened to any
   mode, a condition that ignores the exit code, and one guard replaced by
   `if true` each turn a case red.
6. **What the package must not hold.** Steps that depend on the screen still
   being designed (`handoff propose` / `handoff done`, the popup feature), a new
   kind, `mem purge` / promote / approve in a runnable block, `$<digit>` /
   `$ARGUMENTS`, plain-http URLs. Each is planted in a copy and must be caught.

Wired in `.commandmate/verify.yaml` (`handoff-fixtures`) and in
`.github/workflows/validate.yml` (`runner-suites`), in the same change that
added the suite.
