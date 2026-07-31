#!/usr/bin/env bash
# hooks-task.sh — supply `read_task_status` from the CommandMate task ledger.
#
# Load it alongside hooks-git.sh when the run is contract-driven (Issue #1589,
# CommandMate #1581):
#
#   monitor.sh --hooks <skill-dir>/scripts/hooks-git.sh \
#              --hooks <skill-dir>/scripts/hooks-task.sh <worktree-id> ...
#
# WHY THE CLI AND NOT THE API (measured 2026-07-31, CommandMate develop @0.16.0):
#   `commandmate task list <worktree-id> [--limit n] [--json]` and
#   `GET /api/worktrees/<id>/tasks` return the same rows — the CLI is a thin
#   client over that route. From a shell hook the CLI wins because it already
#   resolves the base URL (CM_PORT) and the auth token (--token / CM_AUTH_TOKEN);
#   curl would have to reproduce both, and would send the token in the process
#   list. `task list` is used rather than `task show <task-id>` because the
#   monitor only ever knows worktree ids: `send --contract` prints the task id,
#   but the supervising loop is started per worktree and would otherwise need
#   that id threaded in per worker. `task list` answers from the worktree alone
#   and sorts newest first, so row 1 is the contract currently in flight.
#
# PRECONDITION: the newest task is the one this monitor run is watching. That
# holds for the standard recipe (create the contract, `send --contract`, then
# monitor). Wiring this hook onto a worktree whose newest task belongs to an
# earlier delegation makes the loop read that older verdict — the pane-state veto
# in verify-completion.sh only catches it while the worker is visibly busy.
#
# Env:
#   CM — commandmate launcher; inherited from monitor.sh when sourced by it.
CM=${CM:-"npx commandmate@latest"}

# read_task_status <worktree-id> -> a TaskStatus, `unavailable`, or empty.
#
# Three answers, because they mean three different things and collapsing them is
# how a degraded run passes for a healthy one:
#
#   <status>      the ledger answered. One of TASK_STATUSES (src/lib/db/tasks-db.ts):
#                 pending running waiting_input verifying succeeded failed
#                 not_started cancelled.
#   ""            the ledger answered and this worktree has no task — a
#                 contract-less delegation. The pre-task behaviour, silently.
#   unavailable   the ledger could not be asked at all. This is the version gate:
#                 monitor.sh reports it once per worker and then runs on the
#                 capture heuristics. `unavailable` is deliberately not a
#                 TaskStatus, so a monitor.sh that predates this file passes it
#                 straight to verify-completion.sh, where it falls through to the
#                 same heuristics instead of deciding anything.
#
# Measured failure modes behind the `unavailable` branch (2026-07-31):
#   CommandMate 0.10.2 (no `task` command)   exit 1,  stderr `unknown option '--limit'`
#   published 0.16.0                         same — `task` is unreleased (npm 0.16.0
#                                            ships no dist/cli/commands/task.js)
#   server not running                       exit 1,  stderr `Server is not running.`
#   worktree unknown to the server           exit 99, stderr `Resource not found.`
# `commandmate task --help` is NOT a usable probe: on 0.10.2 it prints the root
# help and exits 0, so only running the real subcommand distinguishes the two.
read_task_status() {
  ht__line=""
  ht__status=""
  ht__rc=0

  # Non-JSON output is deliberate: it is tab-separated (id, status, agent, gates,
  # title), which `cut` reads with no JSON parser and no jq dependency. The
  # assignment keeps the exit code — piping into `head` here would hand `$?` to
  # head and erase every failure mode listed above.
  ht__line=$($CM task list "$1" --limit 1 2>/dev/null)
  ht__rc=$?
  if [ "$ht__rc" -ne 0 ]; then
    printf 'unavailable\n'
    return 0
  fi

  # When the worktree has no tasks the CLI writes its notice to stderr and stdout
  # is empty, so this is empty too — the contract-less case.
  ht__status=$(printf '%s\n' "$ht__line" | head -n 1 | cut -f2)
  case "$ht__status" in
    pending|running|waiting_input|verifying|succeeded|failed|not_started|cancelled)
      printf '%s\n' "$ht__status"
      ;;
    *)
      # An unrecognised value is treated as "no answer" rather than passed on: a
      # changed output format must degrade to the heuristics, not to a verdict
      # nobody defined.
      printf '\n'
      ;;
  esac
}
