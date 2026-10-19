#!/usr/bin/env bash
# Test suite for the kilo-agents Cinnamon applet.
#
# Starts a handful of mock kilo servers (one password-less, one that requires
# auth on an OS-assigned port, one behind a daemon discovery file) and runs the
# gjs test harnesses against them, with libsoup 3 and with libsoup 2.4.

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d /tmp/kilo-agents-tests.XXXXXX)
PIDS=()

cleanup() {
    for pid in "${PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null
    done
    # belt and braces: every mock names this run's work directory on its command line
    pkill -f -- "$WORK" 2>/dev/null
    wait 2>/dev/null
    rm -rf "$WORK"
}
# Any way of dying must take the mock servers with it: a stray double would
# show up as a phantom agent in a running applet.
trap cleanup EXIT INT TERM HUP

free_port() {
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

FIXED_PORT=$(free_port)
DAEMON_PORT=$(free_port)
DEAD_PORT=$(free_port)

mkdir -p "$WORK/proj-a" "$WORK/proj-b"
STATE="$WORK/state.json"
STATE_B="$WORK/state-b.json"
DAEMON_STATE="$WORK/state-daemon.json"

# Each mock owns its own sessions, so a session's server attribution is
# deterministic. ses_shared_x appears on two servers on purpose: the monitor
# has to merge it into one row.
cat > "$STATE" <<JSON
{
  "projects": [
    {"id": "proj-a", "worktree": "$WORK/proj-a", "vcs": "git", "time": {"created": 1, "updated": 200}, "sandboxes": []},
    {"id": "proj-b", "worktree": "$WORK/proj-b", "vcs": "git", "time": {"created": 1, "updated": 100}, "sandboxes": []}
  ],
  "sessions": [
    {"id": "ses_busy_a", "directory": "$WORK/proj-a", "status": {"type": "busy"}, "title": "Fix the widget", "agent": "code"},
    {"id": "ses_idle_e", "directory": "$WORK/proj-a", "status": {"type": "idle"}, "title": "Finished already", "agent": "code"},
    {"id": "ses_shared_x", "directory": "$WORK/proj-a", "status": {"type": "busy"}, "title": "Seen by two servers", "agent": "code"}
  ]
}
JSON

cat > "$STATE_B" <<JSON
{
  "projects": [
    {"id": "proj-a", "worktree": "$WORK/proj-a", "vcs": "git", "time": {"created": 1, "updated": 200}, "sandboxes": []},
    {"id": "proj-b", "worktree": "$WORK/proj-b", "vcs": "git", "time": {"created": 1, "updated": 100}, "sandboxes": []}
  ],
  "sessions": [
    {"id": "ses_retry_b", "directory": "$WORK/proj-b", "status": {"type": "retry", "attempt": 2, "message": "rate limited", "next": 2000}, "title": "Retry the upload", "agent": "code"},
    {"id": "ses_offline_c", "directory": "$WORK/proj-b", "status": {"type": "offline", "requestID": "que_1", "message": "which file?"}, "title": "Waiting for input", "agent": "ask"},
    {"id": "ses_shared_x", "directory": "$WORK/proj-a", "status": {"type": "busy"}, "title": "Seen by two servers", "agent": "code"}
  ]
}
JSON

cat > "$DAEMON_STATE" <<JSON
{
  "projects": [
    {"id": "proj-a", "worktree": "$WORK/proj-a", "vcs": "git", "time": {"created": 1, "updated": 200}, "sandboxes": []}
  ],
  "sessions": [
    {"id": "ses_daemon_d", "directory": "$WORK/proj-a", "status": {"type": "busy"}, "title": "Daemon session", "agent": "code"}
  ]
}
JSON

cat > "$WORK/daemon.json" <<JSON
{
  "pid": 4242,
  "hostname": "127.0.0.1",
  "port": $DAEMON_PORT,
  "urls": {"local": "http://127.0.0.1:$DAEMON_PORT", "network": "", "bind": "127.0.0.1"},
  "username": "kilo",
  "password": "daemon-secret",
  "version": "9.9.9-test",
  "startedAt": 1792396000000
}
JSON

export MOCK_SERVER="$ROOT/tests/mock-kilo-server.py"
KILO_BIN="$ROOT/tests/bin/kilo"
chmod +x "$KILO_BIN"

# 1. plain server on a fixed port
"$KILO_BIN" serve --port "$FIXED_PORT" --hostname 127.0.0.1 --state "$STATE" --parent-pid $$ >"$WORK/mock-a.log" 2>&1 &
PIDS+=($!)

# 2. server started with --port 0 that requires auth
MOCK_PASSWORD=test-secret-123 "$KILO_BIN" serve --port 0 --hostname 127.0.0.1 --parent-pid $$ \
    --state "$STATE_B" --require-auth --port-file "$WORK/port-b" >"$WORK/mock-b.log" 2>&1 &
PIDS+=($!)

# 3. the daemon server named by the discovery file (own state, own password)
MOCK_PASSWORD=daemon-secret "$KILO_BIN" serve --port "$DAEMON_PORT" --hostname 127.0.0.1 --parent-pid $$ \
    --state "$DAEMON_STATE" --require-auth >"$WORK/mock-d.log" 2>&1 &
PIDS+=($!)

# wait for both dynamic and fixed ports to answer
for _ in $(seq 1 100); do
    if [ -f "$WORK/port-b" ] && curl -s -o /dev/null "http://127.0.0.1:$FIXED_PORT/project"; then
        break
    fi
    sleep 0.1
done
if [ ! -f "$WORK/port-b" ]; then
    echo "mock servers did not start:" >&2
    cat "$WORK"/mock-*.log >&2
    exit 1
fi

export KILO_TEST_ROOT="$ROOT"
export KILO_TEST_WORK="$WORK"
export KILO_TEST_STATE="$STATE"
export KILO_TEST_STATE_B="$STATE_B"
export KILO_TEST_PROJ_A="$WORK/proj-a"
export KILO_TEST_PROJ_B="$WORK/proj-b"
export KILO_TEST_FIXED_PORT="$FIXED_PORT"
export KILO_TEST_DAEMON_PORT="$DAEMON_PORT"
export KILO_TEST_DEAD_PORT="$DEAD_PORT"
export KILO_TEST_DYNAMIC_PORT_FILE="$WORK/port-b"

echo "=== lib tests (libsoup 3) ==="
gjs "$ROOT/tests/test-lib.js"
STATUS_LIB=$?

echo
echo "=== client tests (libsoup 2.4) ==="
gjs "$ROOT/tests/test-client-soup2.js"
STATUS_SOUP2=$?

echo
if [ "$STATUS_LIB" -eq 0 ] && [ "$STATUS_SOUP2" -eq 0 ]; then
    echo "ALL TESTS PASSED"
    exit 0
fi
echo "TESTS FAILED (lib=$STATUS_LIB soup2=$STATUS_SOUP2)"
exit 1
