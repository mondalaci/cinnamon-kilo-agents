# Kilo Agents - Cinnamon applet

Shows, in the Cinnamon panel, which kilo agents are working right now: one
chip per active agent, side by side, with a robot/agent icon and the shortened
session title.

```
🤖 Refactor the paym…   🤖 Fix the widget t…   🤖 Ask about the s…   +2
```

<p align="center">
  <img src="docs/panel.png" alt="the applet in the panel" width="520">
</p>

- **Icon** - a ready-made robot/agent icon (Lucide's `bot`), rendered as a
  smooth scalable icon. Every agent shows the same icon, whatever model it runs.
- **Title** - the session's title, shortened to the configured length.
- **`+N`** - more agents are active than the chip limit allows.
- **Motion** - a session that starts slides in from the left and fades in. One
  that finishes flashes **inverted three times** (dark artwork on the panel's
  text tone), then slides out to the left and fades out, while the chips to its
  right take the freed space back so the row never jumps. Turn it off with
  *Animate new and finished agents*.
- **Idle** - a dimmed robot icon, or nothing at all if you prefer
  (*Hide the panel icon when no agent is working*).
- **Never any desktop notification** - the applet only draws in the panel. The
  tooltip and the menu carry the details.

Clicking the applet opens the menu: every active session per server with its
project, agent, model, status and (optionally) cost, plus per-session actions
(copy the session ID, or run a command). Hovering shows a tooltip summary.

Statuses are `busy` (working), `retry` (rate limit or provider error, with the
attempt number and delay) and `offline` (the agent asked a question and waits
for an answer). Idle sessions are not listed, and a session that several
servers know about is shown once.

## Install

```sh
./install.sh                    # symlink into ~/.local/share/cinnamon/applets + add to the panel
./install.sh --copy             # copy the files instead of symlinking
./install.sh --no-enable        # install only, leave the panel alone
./install.sh --panel-right 5    # place it at panel1:right:5
./uninstall.sh                  # remove the panel entry, config and files
```

Cinnamon loads the applet immediately. Settings: right-click the applet ->
*Configure*, or `cinnamon-settings applets`.

Requirements: Cinnamon 5.4+ (developed on 6.6.9), `gjs`, and `python3` for the
installer and the test suite. The applet itself needs nothing extra: it talks
HTTP with the libsoup Cinnamon already links against and reads `/proc` with
GLib.

## Why every server is queried

Kilo keeps its session list in a shared SQLite database
(`~/.local/share/kilo/kilo.db`), but the *working* state (`busy` / `retry` /
`offline`) lives in the memory of the server process running the agent - it is
not in the database. Each VS Code window starts its own `kilo serve --port 0`,
so one server only knows about its own sessions.

The applet finds every kilo server it can and merges the answers:

1. **daemon discovery file** - `~/.local/state/kilo/daemon.json`, written by
   `kilo daemon`; carries port, username and password.
2. **configured servers** - the *Additional servers* setting
   (`host:port` or `host:port:username:password`), for a fixed port or a server
   on another machine.
3. **/proc scan** - processes whose command line contains `serve` and whose
   environment carries `KILO_*` variables, which is how the VS Code extension's
   servers are recognised. The port comes from `--port`, and for a server
   started with `--port 0` the listening socket is resolved through
   `/proc/net/tcp`; credentials come from `KILO_SERVER_PASSWORD` /
   `KILO_SERVER_USERNAME` in `/proc/<pid>/environ`.

Servers are deduplicated by `host:port` (keeping the entry with credentials),
so a daemon server that the `/proc` scan also finds is queried once.

Test doubles started by `tests/bin/kilo` export `KILO_AGENTS_MOCK=1`, and the
`/proc` scan skips processes carrying that marker, so running the test suite
never puts phantom agents into a live panel. The suite opts back in with
`{ includeMocks: true }` where it needs to see them; the mock servers also
watch their parent process and exit if the harness dies, so an interrupted test
run cannot leave them behind.

## What is read from a server

| Request | Purpose |
| --- | --- |
| `GET /project` | candidate project directories, most recently used first |
| `GET /session/status?directory=<dir>` | which sessions are not idle in that directory |
| `GET /api/session?directory=<dir>&limit=N` | title, agent, model, cost, tokens, timestamps |

`/session/status` only reports the directory the server was pointed at, so the
applet sweeps the project list from `/project` (bounded by *Projects checked per
server*). `/api/session/active` is deliberately not used: it stays empty for
these sessions even while one is provably busy.

Auth is HTTP Basic (`kilo` + password); a request without credentials to a
server that requires them yields 401 and that server is reported unreachable.

## Agent icon

The chip icon is a ready-made third-party robot icon, **Lucide's `bot`**
(ISC licensed, [lucide.dev](https://lucide.dev)), shipped in `icons/` and
rendered as a normal scalable icon (`St.Icon` with the SVG file), so it stays
smooth at any size - no hand-drawn pixel art. Every agent shows the same icon,
regardless of the model it runs.

There is deliberately no icon chooser: to use a different icon, drop an SVG with
the same file name into `icons/` and its inverse twin beside it. The files are
unmodified except for the colour - `currentColor` becomes the panel tone
`#c6cdd6`, and `icons/lucide-bot-inverted.svg` is the same artwork in the panel
background tone `#1a1a1a`, which a finished chip flashes. Each file keeps its
source and licence in a header comment, and the test suite checks that the
inverted file is the same artwork in the inverse colour.

If the file cannot be loaded, the applet falls back to the theme's
`avatar-default-symbolic` icon and logs the reason.

## Settings

| Page | Keys |
| --- | --- |
| General | poll interval (2 s), session details refresh (30 s), sessions per project (20), projects per server (60) |
| Servers | daemon file on/off + path, `/proc` scan on/off, additional servers |
| Panel | icon size (48), shortened title length (18), show the title, agents shown side by side (3), animate new/finished agents, hide when idle |
| Menu | session title length, show model, show directory, show cost/tokens, list idle servers |
| Actions | session action: copy the session ID, run a command (`{id} {title} {dir} {agent} {model} {status}`), or nothing |

There is no notification setting: the applet never shows desktop notifications.

## Repository layout

```
kilo-agents@laci/         the applet (installed as one directory)
  applet.js               chip row, tooltip, menu, actions
  lib/procfs.js           /proc helpers (cmdline, environ, listening sockets)
  lib/discovery.js        server discovery: daemon file, config, /proc scan
  lib/client.js           async HTTP client for both libsoup 3 and libsoup 2.4
  lib/monitor.js          poll loop, directory sweep, per-server merge
  lib/format.js           tooltip/menu formatting (pure functions)
  lib/agenticon.js        resolves the icon file paths (pure, testable)
  icons/lucide-bot.svg    the agent icon (Lucide bot, ISC), tinted to the panel tone
  icons/lucide-bot-inverted.svg   the same artwork for the finishing blink
  settings-schema.json    settings UI definition
docs/panel.png
install.sh uninstall.sh
tests/
  run-tests.sh            starts mock servers, runs both gjs suites
  mock-kilo-server.py     server double with the real payload shapes
  bin/kilo                wrapper making the mock look like `kilo serve`
  test-lib.js             unit + integration tests (libsoup 3)
  readme-screenshot.sh    regenerates docs/panel.png from a running applet
  test-client-soup2.js    the same client on libsoup 2.4 (Cinnamon 5.x)
```

## Tests

```sh
tests/run-tests.sh
```

The suite starts three mock servers (one password-less, one that requires auth
on an OS-assigned `--port 0` port, one announced by a daemon discovery file)
and covers:

- panel/menu formatting helpers (titles, durations, cost, tooltips)
- the agent icon: that the file exists, is an SVG, carries its licence note, is
  tinted (no `currentColor` left) and has an inverted twin with the same artwork
  in the inverse colour, that its paths cannot escape the applet directory, and
  that the settings offer no icon chooser any more
- the chip animation timing: the easing curves and the blink schedule (three
  inverted flashes, ending back in the normal look)
- that the applet's discovery skips the test doubles while they are running and
  answering, and that the suite can still see them on request
- server-spec and discovery-file parsing, including broken input
- `/proc` discovery: fixed port, `--port 0` resolved via `/proc/net/tcp`,
  password read from `environ`, own process excluded, deduplication
- the HTTP client: payload shapes, 401 without credentials, 404, refused
  connections - on libsoup 3 and on libsoup 2.4
- the monitor: directory sweep, status classification, metadata join, per
  server attribution, unreachable servers isolated, duplicate sessions merged,
  live reaction to sessions starting and finishing, `stop()`

## Development notes

- Editing `applet.js` and reloading the applet (`org.Cinnamon.ReloadXlet`) is
  enough to pick up the change. Edited `lib/*.js` modules stay cached in the
  Cinnamon process, so those need a Cinnamon restart
  (`org.Cinnamon.RestartCinnamon true`) - a fresh start always works.
- The chip animations are driven by the applet's own frame loop
  (`lib/easing.js` + a 16 ms `GLib.timeout_add`) rather than by Clutter easing.
  Cinnamon applies an actor's final value immediately when desktop animations
  are switched off (`St.Settings.animations_enabled`, false on plenty of
  installs), which would silently turn every `ease()` into a jump; driving the
  interpolation here keeps the slide visible for anyone who asked for it, and
  the `animate-chips` setting is the switch that matters.
- `St.Icon` multiplies `icon_size` by the stage scale factor while the applet's
  icon size setting is plain pixels; `createAgentIcon` divides it back out, so
  a 48 px setting really is 48 px on screen (24 logical units at scale 2).
- `docs/panel.png` shows example titles, not a live session, and is generated
  by `tests/readme-screenshot.sh`: it starts a marked mock (invisible to `/proc`
  discovery), plugs it in through *Settings -> Servers -> Additional servers* so
  the applet renders it through its normal data path, waits for the row to
  settle, and refuses to write the image unless it is actually bright enough
  (an off-target crop once produced a nearly black README screenshot). Never
  inject a model into a live applet: the panel keeps showing it until the applet
  is reloaded.
- `node --check <file>` validates the syntax of every JS file.

## Limitations

- Status is per server process, so a Kilo instance on another machine shows up
  only if it is listed in *Additional servers* and its `/session/status` is
  reachable from here.
- The `/proc` scan needs the servers to run as the same user; otherwise their
  environment is unreadable and they are skipped.
- The chip icon does not distinguish agents: every session shows the same
  robot/agent icon.
