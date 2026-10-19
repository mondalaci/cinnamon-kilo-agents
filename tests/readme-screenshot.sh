#!/usr/bin/env bash
# Regenerates docs/panel.png from a running Cinnamon applet.
#
# The image must not carry real session data, so the chips it shows come from a
# mock server with example titles: the mock is marked (KILO_AGENTS_MOCK), which
# keeps it invisible to /proc discovery, and it is plugged in through the
# applet's own "Additional servers" setting - the applet renders it through its
# normal data path, nothing is injected into a live applet.
#
# The capture is checked before it is written: an off-target crop produced a
# nearly black image once, and a README screenshot is not worth re-checking by
# eye. Requires a running Cinnamon with the applet loaded, ImageMagick's
# `import`, python3 and Pillow.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID="kilo-agents@laci"
# a fresh free port by default: a leftover mock on the usual one would silently
# serve the image instead of this run's
PORT="${PORT:-$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
SETTINGS="${XDG_CONFIG_HOME:-$HOME/.config}/cinnamon/spices/$UUID/$UUID.json"
WORK=$(mktemp -d /tmp/kilo-agents-shot.XXXXXX)
OUT="$ROOT/docs/panel.png"
EXAMPLE_DIR="/home/user/projects/example"

if [ ! -f "$SETTINGS" ]; then
    echo "no applet settings at $SETTINGS - is the applet installed and loaded?" >&2
    exit 1
fi

cat > "$WORK/state.json" <<JSON
{
  "projects": [{"id": "example", "worktree": "$EXAMPLE_DIR", "vcs": "git", "time": {"created": 1, "updated": 2}, "sandboxes": []}],
  "sessions": [
    {"id": "ses_shot_1", "directory": "$EXAMPLE_DIR", "status": {"type": "busy"}, "title": "Refactor the payment adapter", "agent": "code", "time": {"created": 1, "updated": 4102444800000}},
    {"id": "ses_shot_2", "directory": "$EXAMPLE_DIR", "status": {"type": "busy"}, "title": "Fix the widget tests", "agent": "code", "time": {"created": 1, "updated": 4102444800000}},
    {"id": "ses_shot_3", "directory": "$EXAMPLE_DIR", "status": {"type": "retry", "attempt": 2, "next": 3000}, "title": "Retry the upload", "agent": "code", "time": {"created": 1, "updated": 4102444800000}},
    {"id": "ses_shot_4", "directory": "$EXAMPLE_DIR", "status": {"type": "busy"}, "title": "Review the pull request", "agent": "code", "time": {"created": 1, "updated": 4102444800000}},
    {"id": "ses_shot_5", "directory": "$EXAMPLE_DIR", "status": {"type": "busy"}, "title": "Plan the migration", "agent": "plan", "time": {"created": 1, "updated": 4102444800000}}
  ]
}
JSON

MOCK_SERVER="$ROOT/tests/mock-kilo-server.py" "$ROOT/tests/bin/kilo" serve \
    --port "$PORT" --hostname 127.0.0.1 --state "$WORK/state.json" >"$WORK/mock.log" 2>&1 &
MOCK_PID=$!

# the mock must be up before the applet is pointed at it
ready=0
for _ in $(seq 1 50); do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/project"; then
        ready=1
        break
    fi
    sleep 0.1
done
if [ "$ready" != "1" ]; then
    echo "the mock server did not come up on port $PORT" >&2
    cat "$WORK/mock.log" >&2 || true
    exit 1
fi

previous=$(python3 - "$SETTINGS" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["extra-servers"]["value"])
PY
)

cleanup() {
    python3 - "$SETTINGS" "$previous" <<'PY' 2>/dev/null || true
import json, sys
path, value = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data["extra-servers"]["value"] = value
with open(path, "w") as handle:
    json.dump(data, handle, indent=4)
PY
    # tell the applet, not just the settings file, so it drops the mock on its
    # next sweep instead of keeping a dead server in its model
    dbus-send --session --dest=org.Cinnamon --print-reply /org/Cinnamon org.Cinnamon.Eval \
        "string:const ap = imports.ui.appletManager.definitions.filter(function(x){return x.uuid === \"$UUID\"})[0].applet; if (ap) { ap.settings.remoteUpdate(\"extra-servers\", \"$previous\"); } \"ok\"" \
        >/dev/null 2>&1 || true
    kill "$MOCK_PID" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM HUP

# plug the mock in through the applet's own setting, exactly like the settings dialog
python3 - "$SETTINGS" "127.0.0.1:$PORT" <<'PY'
import json, sys
path, value = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data["extra-servers"]["value"] = value
with open(path, "w") as handle:
    json.dump(data, handle, indent=4)
PY
eval_applet() {
    dbus-send --session --dest=org.Cinnamon --print-reply /org/Cinnamon org.Cinnamon.Eval \
        "string:const ap = imports.ui.appletManager.definitions.filter(function(x){return x.uuid === \"$UUID\"})[0].applet; $1; \"ok\"" \
        >/dev/null 2>&1
}

eval_applet 'ap.settings.remoteUpdate("extra-servers", "127.0.0.1:'"$PORT"'")'
sleep 4

# wait for the row to be settled (no chip mid-animation) and full
settled=0
for _ in $(seq 1 40); do
    eval_applet 'const p = ap.actor.get_transformed_position(); const s = ap.actor.get_transformed_size(); const still = ap._chipsBox.get_children().every(function (a) { return a.opacity === 255 && a.translation_x === 0; }); imports.gi.GLib.file_set_contents("/tmp/kilo-agents-shot-geo.json", JSON.stringify({geo: [Math.round(p[0]), Math.round(p[1]), Math.round(s[0]), Math.round(s[1])], settled: still, chips: ap._chipIds.length, titles: ap._model.sessions.map(function (m) { return m.title; })}))'
    if python3 - <<'PY'
import json
try:
    state = json.load(open('/tmp/kilo-agents-shot-geo.json'))
except (OSError, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if state["settled"] and state["chips"] >= 4 and not state["titles"][0].startswith("Cinnamon applet") else 1)
PY
    then
        settled=1
        break
    fi
    sleep 0.5
done
if [ "$settled" != "1" ]; then
    echo "the chip row never settled with the example sessions" >&2
    python3 -c "import json;print(json.load(open('/tmp/kilo-agents-shot-geo.json')))" >&2 || true
    exit 1
fi

python3 - "$OUT" <<'PY'
import json, subprocess, sys
from PIL import Image

out = sys.argv[1]
state = json.load(open('/tmp/kilo-agents-shot-geo.json'))
x, y, w, h = state["geo"]
subprocess.run(["import", "-window", "root", "-crop", "%dx%d+%d+%d" % (w + 16, h + 4, max(0, x - 8), max(0, y - 2)),
                "+repage", "/tmp/kilo-agents-shot.png"], check=True)
image = Image.open('/tmp/kilo-agents-shot.png').convert("RGB")
pixels = list(image.getdata())
mean = sum(sum(c) / 3 for c in pixels) / len(pixels)
bright = sum(1 for c in pixels if sum(c) / 3 > 120)
print("captured %dx%d, mean %.1f, %d bright pixels (%.1f%%)" % (image.width, image.height, mean, bright, 100 * bright / len(pixels)))
if bright < 500 or mean < 25:
    raise SystemExit("refusing to write a dim/empty screenshot")
image.resize((image.width * 2, image.height * 2), Image.NEAREST).save(out)
print("wrote", out)
PY
