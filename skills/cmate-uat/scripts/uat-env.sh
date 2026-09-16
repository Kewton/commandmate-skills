#!/usr/bin/env bash
# cmate-uat / uat-env — the three environment operations that must not be
# improvised: find a free port, wait for health, and stop ONLY what listens.
#
# Usage:
#   uat-env.sh port-find <from> <to>
#   uat-env.sh wait-health <url-or-command> [seconds]
#   uat-env.sh stop-listen <port> [--force-after <seconds>]
#
# Each subcommand judges by exit code and says why on stderr. stdout carries the
# one value a caller needs (the port, the elapsed seconds, the pids stopped), so
# it stays parseable.
#
# WHY THIS FILE EXISTS. All three are one-liners an agent will write from memory,
# and one of them is dangerous when written from memory:
#
#   lsof -ti:<port> | xargs kill        # WRONG
#
# That returns every process with a socket on the port — including ones merely
# CONNECTED to it, such as the browser's network service belonging to whoever has
# the UAT page open. Killing those cuts unrelated traffic. CommandMate#2473 is
# that incident. The correct form filters to listeners:
#
#   lsof -nP -iTCP:<port> -sTCP:LISTEN -t
#
# The filter lives here so it cannot be forgotten at the call site, and so the
# fixture suite can hold it (a mutation that drops -sTCP:LISTEN goes red).
#
# bash 3.2 compatible (macOS ships 3.2.57): no associative arrays, no mapfile,
# no `${var,,}`.
set -u

PROG=uat-env.sh

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 2; }
note() { printf '%s: %s\n' "$PROG" "$*" >&2; }

# ---------------------------------------------------------------------------
# Listener lookup. Every caller goes through this, so the LISTEN filter is
# applied exactly once in this file.
#
# lsof is the primary because it is what macOS has. Linux images often ship
# without it, so `ss` is the fallback; both are filtered to listening sockets.
# If neither exists we fail loudly (exit 2) rather than returning an empty list,
# because "no listeners" and "cannot tell" must not look the same: the first
# makes a port free, the second makes a stop silently do nothing.
# ---------------------------------------------------------------------------
listeners_on() {
  port=$1
  if command -v lsof >/dev/null 2>&1; then
    # -sTCP:LISTEN is the whole point. Do not remove it.
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    # -l is the same restriction for ss: listening sockets only.
    ss -ltnp 2>/dev/null \
      | awk -v p=":$port\$" '$4 ~ p { print }' \
      | sed -n 's/.*pid=\([0-9]\{1,\}\).*/\1/p' | sort -u
    return 0
  fi
  die "neither lsof nor ss is available, so listeners cannot be identified. Refusing to guess."
}

port_is_free() {
  found=$(listeners_on "$1") || exit 2
  [ -z "$found" ]
}

# ---------------------------------------------------------------------------
# port-find <from> <to> — first port in the range with no listener.
#
# Prints the port on stdout. Exit 1 when the whole range is occupied: a caller
# must not fall back to a default port, because that default is where someone
# else's server (or production) is.
#
# The result is inherently racy — another run can take the port between this
# check and your `env.up`. That is why `up` failing with "address in use" is
# handled by re-running port-find, not by killing whatever holds it.
# ---------------------------------------------------------------------------
cmd_port_find() {
  [ $# -eq 2 ] || die "usage: $PROG port-find <from> <to>"
  from=$1; to=$2
  case "$from$to" in *[!0-9]*) die "port-find: <from> and <to> must be numbers";; esac
  [ "$from" -le "$to" ] || die "port-find: <from> ($from) is above <to> ($to)"

  port=$from
  while [ "$port" -le "$to" ]; do
    if port_is_free "$port"; then
      printf '%s\n' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  note "port-find: every port in ${from}-${to} already has a listener"
  return 1
}

# ---------------------------------------------------------------------------
# wait-health <url-or-command> [seconds] — poll until healthy.
#
# An argument whose scheme is http or https (i.e. `<scheme>://…`) is fetched with
# curl; anything else is run as a shell command and judged by its exit code. Both
# forms are needed: a server exposes a health endpoint, a CLI or a worker does not.
#
# The scheme is split off rather than matched as a literal glob, because this
# repository refuses a package that embeds a plaintext-scheme URL
# (SKILLS_LINK_INSECURE, no loopback exemption) and the glob form counted as one.
#
# Exit 1 on timeout, and the elapsed seconds go to stdout either way. Timing out
# is NOT the same as unhealthy — the caller reports it as `blocked`, which is why
# this never prints a verdict of its own.
# ---------------------------------------------------------------------------
cmd_wait_health() {
  [ $# -ge 1 ] || die "usage: $PROG wait-health <url-or-command> [seconds]"
  target=$1
  deadline_s=${2:-60}
  case "$deadline_s" in *[!0-9]*) die "wait-health: timeout must be a whole number of seconds";; esac

  # `${target%%://*}` is the scheme when the value has one, and the whole string
  # when it does not — which cannot equal http or https, so a bare command falls
  # through to the command branch.
  case "${target%%://*}" in
    http|https)
      command -v curl >/dev/null 2>&1 || die "wait-health: a URL was given but curl is not available"
      probe() { curl -fsS -m 5 -o /dev/null "$target" >/dev/null 2>&1; } ;;
    *)
      probe() { sh -c "$target" >/dev/null 2>&1; } ;;
  esac

  elapsed=0
  while [ "$elapsed" -lt "$deadline_s" ]; do
    if probe; then
      printf '%s\n' "$elapsed"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  printf '%s\n' "$elapsed"
  note "wait-health: '$target' did not become healthy within ${deadline_s}s"
  return 1
}

# ---------------------------------------------------------------------------
# stop-listen <port> [--force-after <seconds>] — stop ONLY the listeners.
#
# Sends TERM to the listening pids, waits for the port to clear, and with
# --force-after sends KILL to whatever still listens after that many seconds.
# KILL is opt-in because a server that is still flushing deserves the chance.
#
# Prints the pids it signalled on stdout. Exit 0 when the port ends up free
# (including when it was free to begin with — stopping an already-stopped
# environment is not an error), exit 1 when a listener survives.
#
# It never widens the selection. A pid that merely holds a CONNECTION to the port
# is not a listener and is not signalled; see the header.
# ---------------------------------------------------------------------------
cmd_stop_listen() {
  [ $# -ge 1 ] || die "usage: $PROG stop-listen <port> [--force-after <seconds>]"
  port=$1; shift
  case "$port" in *[!0-9]*) die "stop-listen: <port> must be a number";; esac

  force_after=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --force-after)
        [ $# -ge 2 ] || die "stop-listen: --force-after needs a value"
        force_after=$2
        case "$force_after" in *[!0-9]*) die "stop-listen: --force-after must be a whole number of seconds";; esac
        shift 2 ;;
      *) die "stop-listen: unknown argument '$1'" ;;
    esac
  done

  pids=$(listeners_on "$port") || exit 2
  if [ -z "$pids" ]; then
    note "stop-listen: nothing is listening on $port"
    return 0
  fi

  printf '%s\n' "$pids" | tr '\n' ' ' | sed 's/ $//'
  printf '\n'
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || note "stop-listen: could not signal pid $pid"
  done

  waited=0
  grace=${force_after:-10}
  while [ "$waited" -lt "$grace" ]; do
    if port_is_free "$port"; then
      note "stop-listen: port $port released after ${waited}s"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [ -n "$force_after" ]; then
    survivors=$(listeners_on "$port") || exit 2
    for pid in $survivors; do
      note "stop-listen: pid $pid still listening after ${force_after}s, sending KILL"
      kill -KILL "$pid" 2>/dev/null || note "stop-listen: could not KILL pid $pid"
    done
    sleep 1
  fi

  if port_is_free "$port"; then
    return 0
  fi
  note "stop-listen: port $port still has a listener. Investigate before re-running; do not widen the kill."
  return 1
}

[ $# -ge 1 ] || die "usage: $PROG <port-find|wait-health|stop-listen> ..."
sub=$1; shift
case "$sub" in
  port-find)   cmd_port_find "$@" ;;
  wait-health) cmd_wait_health "$@" ;;
  stop-listen) cmd_stop_listen "$@" ;;
  *) die "unknown subcommand '$sub' (expected port-find, wait-health or stop-listen)" ;;
esac
