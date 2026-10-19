#!/usr/bin/env python3
"""A tiny stand-in for `kilo serve`, used by the applet's test suite.

It implements exactly the three endpoints the applet reads, with the same
payload shapes the real server produces:

    GET /project                                -> [{id, worktree, vcs, time, sandboxes}]
    GET /session/status[?directory=<dir>]       -> {"<sessionID>": {"type": ...}}
    GET /api/session?directory=<dir>&limit=<n>  -> {"data": [Session.Info], "cursor": {...}}

Who is busy is read from a state file on every request, so tests can change
the world while the server keeps running. `serve` is accepted as a subcommand
and the --port/--hostname flags are honoured (including --port 0) so that the
process looks like a real kilo server in /proc.
"""

import argparse
import base64
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DEFAULT_USER = "kilo"


def watch_parent(pid, interval=2.0):
    """Exit when the process that started us is gone.

    A test run that is killed (timeout, Ctrl-C, crash) must not leave mock
    servers behind: they look like real kilo servers to the applet.
    """
    while True:
        time.sleep(interval)
        try:
            os.kill(pid, 0)
        except OSError:
            os._exit(0)


def load_state(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {"projects": [], "sessions": []}


def session_info(session):
    model = session.get("model") or {}
    return {
        "id": session["id"],
        "projectID": session.get("projectID", "test-project"),
        "agent": session.get("agent", "code"),
        "model": {
            "id": model.get("id", "openrouter/deepseek-v4.1-flash"),
            "providerID": model.get("providerID", "openrouter"),
            "variant": model.get("variant", ""),
        },
        "cost": session.get("cost", 0.0123),
        "tokens": session.get("tokens", {"input": 1200, "output": 300, "reasoning": 50,
                                        "cache": {"read": 0, "write": 0}}),
        "time": session.get("time", {"created": 1792396000000, "updated": 1792396900000}),
        "title": session.get("title", "untitled session"),
        "location": {"directory": session.get("directory")},
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("MOCK_VERBOSE"):
            sys.stderr.write("mock: " + fmt % args + "\n")

    def _send(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if not self.server.require_auth:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:]).decode()
        except Exception:
            return False
        user, _, password = decoded.partition(":")
        return user == self.server.user and password == self.server.password

    def do_GET(self):
        if not self._authorized():
            self._send({"error": "unauthorized"}, 401)
            return

        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        directory = query.get("directory", [None])[0]
        state = load_state(self.server.state_file)
        sessions = state.get("sessions", [])

        if parsed.path == "/project":
            self._send(state.get("projects", []))
            return

        if parsed.path == "/session/status":
            statuses = {}
            for session in sessions:
                if directory is None:
                    # Like the real server: the bare endpoint only reports the
                    # server's own instance directory, which the mock does not
                    # have, so nothing matches.
                    if session.get("directory") is None:
                        statuses[session["id"]] = session.get("status", {"type": "busy"})
                    continue
                if session.get("directory") == directory:
                    statuses[session["id"]] = session.get("status", {"type": "busy"})
            self._send(statuses)
            return

        if parsed.path == "/api/session":
            limit = int(query.get("limit", ["50"])[0])
            selected = [s for s in sessions if directory is None or s.get("directory") == directory]
            self._send({
                "data": [session_info(s) for s in selected[:limit]],
                "cursor": {"previous": None, "next": None},
            })
            return

        self._send({"error": "not found", "path": parsed.path}, 404)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="serve")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--hostname", default="127.0.0.1")
    parser.add_argument("--state", required=True)
    parser.add_argument("--port-file", default=None)
    parser.add_argument("--require-auth", action="store_true")
    parser.add_argument("--user", default=DEFAULT_USER)
    parser.add_argument("--password", default=os.environ.get("KILO_SERVER_PASSWORD", ""))
    parser.add_argument("--parent-pid", type=int, default=None)
    args, _unknown = parser.parse_known_args()

    if args.parent_pid:
        threading.Thread(target=watch_parent, args=(args.parent_pid,), daemon=True).start()

    server = ThreadingHTTPServer((args.hostname, args.port), Handler)
    server.state_file = args.state
    server.require_auth = args.require_auth
    server.user = args.user
    server.password = args.password

    port = server.server_address[1]
    if args.port_file:
        with open(args.port_file, "w") as handle:
            handle.write(str(port))
    sys.stderr.write("mock kilo server on %s:%d (auth=%s, state=%s)\n"
                     % (args.hostname, port, args.require_auth, args.state))
    sys.stderr.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
