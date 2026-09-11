# tests/fixtures/cmate-workspace-research

Regression suite for the `cmate-workspace-research` package.

```bash
bash tests/fixtures/cmate-workspace-research/run_tests.sh
```

No network, no CommandMate server, no Agent session: bash, python3 (standard
library only) and the POSIX tools. Wired into `.commandmate/verify.yaml`
(`workspace-research-fixtures`) and `.github/workflows/validate.yml`
(`runner-suites`) in the same change that added the suite.

| file | what it holds |
|---|---|
| `run_tests.sh` | the suite. Prints `ok` / `FAIL` per case and exits 1 on any failure |
| `check_run.py` | the run-dir checker (`<run-dir>`), the package checker (`--package`) and the fixture self-test (`--selftest`) |
| `two-agent-contradiction/repo/` | the synthetic workspace the two children "investigated" — every `path:line` in the runs resolves here |
| `two-agent-contradiction/runs/cross-check-correction/` | run 1: both children finish, disagree, and the cross check corrects the initial conclusion (`What Changed Through Cross Check` is not empty, one `UNRESOLVED CONTRADICTION` remains) |
| `two-agent-contradiction/runs/prompt-stopped/` | run 2: `antigravity` stops on a permission dialog (exit 10) while investigating; `command-code` finishes alone, the cross check is self-refutation only, `What Changed` says `修正なし`, and the coverage line says the run was reduced |

Each run is the expected shape of `.commandmate/workspace-research/<run-id>/`
(`skills/cmate-workspace-research/references/artifacts.md`): `run.json`,
`commands.log`, `brief.md`, `roles/`, `sent/`, `agents/*.{json,exit,log}` in the
`ask --json` history form, `challenges/`, `integrity/`, `cross-check.md`,
`evidence.md` and `final.md`.

**The scenario is synthetic.** It is the Node.js 24 migration example of the
spec (section 21 / section 50). `pkg-x` / `pkg-y` are placeholders, every Web
source is on a reserved `example.com` / `example.org` domain, and no claim in
the runs is about a real package.

## What is proved

1. **SKILL.md still carries the confirmed spec** (A–I of Issue #245 and the
   section 37 failure handling) — one literal per rule, each of which is
   deleted from a copy to prove the check notices.
2. **No runnable snippet in the package answers for a child.** Every fenced
   block in `SKILL.md` and `references/` is scanned for `commandmate respond` /
   `auto-yes` / `interrupt`, `--auto-yes`, `--async`, `--reply-to`, by awk in
   `run_tests.sh` and again by `check_run.py`.
3. **The templates in `references/` are complete**: the five fields of the
   research, probe and challenge messages (ja and en), the `agents/` read
   prohibition and the no-write clause, the research contract living in the
   role template and **not** in the message, the fixed warm-up text, and the
   headings of `brief.md` / `cross-check.md` / `final.md`.
4. **Both runs pass every run rule** (`check_run.py` lists them by id):
   history-shaped replies (AC-03), no mention of the other child in the
   independent phase (AC-04), Workspace-first / External-first assigned after
   the probe (AC-05), evidence locators by the regexes in
   `references/evidence-rules.md` section 4.3 — read from that file, so the rule
   and the check cannot drift — and resolved against `repo/` (AC-07 / AC-08),
   agent consensus rejected as evidence (AC-12), the section 33 headings
   (AC-14), the before/after `git status --porcelain` comparison (AC-15), no
   `respond` / `auto-yes` in `commands.log` (AC-18), `UNRESOLVED CONTRADICTION`
   kept (AC-17).
5. **Every run rule rejects something.** One mutation per rule is applied to a
   copy of a run and has to fire exactly that rule; the self-test fails if any
   rule id is never seen to fire.
6. **A stopped child still leaves a final, whichever exit code stopped it**
   (AC-16): the prompt-stopped run is re-cut with exit 124 (`timeout`), exit 21
   (`failed`) and exit 2 with `waiting on a prompt` (`prompt_stopped`), and a
   124 recorded as `completed` is rejected.

## Not proved here

- **AC-20, the live run.** No real pair of children was driven for this
  fixture: the runs are hand-built expected shapes, not captures.
  The live run (two children — claude and command-code with Auto-Yes ON — on
  the Node.js 24 request, `What Changed Through Cross Check` written, the
  workspace clean before and after) needs those sessions and is reported
  separately.
- That an Agent actually follows `SKILL.md`. That is a rubric measurement on
  real sessions and is unmeasured for every Agent.
- CommandMate's own behaviour (`ask --json`, the exit codes, the transcript
  readers). The fixture fixes what the procedure does *given* them; the shapes
  were read from the CommandMate CLI source and `commandmate docs --section
  delegation`.
