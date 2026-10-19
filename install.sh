#!/usr/bin/env bash
# Install the Kilo Agents applet into Cinnamon.
#
#   ./install.sh                 symlink into ~/.local/share/cinnamon/applets
#                                and add it to the panel
#   ./install.sh --copy          copy instead of symlinking (for a fixed install)
#   ./install.sh --no-enable     install only, do not touch the panel layout
#   ./install.sh --panel-right N place it at panel1:right:N

set -euo pipefail

UUID="kilo-agents@laci"
SRC_DIR=$(cd "$(dirname "$0")" && pwd)/$UUID
DEST_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/applets"
DEST="$DEST_ROOT/$UUID"
PANEL_POSITION=5
MODE=symlink
ENABLE=1

while [ $# -gt 0 ]; do
    case "$1" in
        --copy) MODE=copy ;;
        --symlink) MODE=symlink ;;
        --no-enable) ENABLE=0 ;;
        --panel-right) PANEL_POSITION="$2"; shift ;;
        -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

if [ ! -d "$SRC_DIR" ]; then
    echo "cannot find the applet sources at $SRC_DIR" >&2
    exit 1
fi

command -v gjs >/dev/null 2>&1 || echo "warning: gjs not found - is Cinnamon installed?" >&2

mkdir -p "$DEST_ROOT"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    rm -rf "$DEST"
fi

if [ "$MODE" = "symlink" ]; then
    ln -s "$SRC_DIR" "$DEST"
    echo "linked $DEST -> $SRC_DIR"
else
    cp -r "$SRC_DIR" "$DEST"
    echo "copied $SRC_DIR -> $DEST"
fi

if [ "$ENABLE" = "1" ]; then
    python3 - "$UUID" "$PANEL_POSITION" <<'PY'
import ast
import subprocess
import sys

uuid, position = sys.argv[1], sys.argv[2]
schema = "org.cinnamon"
key = "enabled-applets"

raw = subprocess.run(["gsettings", "get", schema, key],
                     capture_output=True, text=True, check=True).stdout
entries = [entry for entry in ast.literal_eval(raw) if uuid not in entry]

instance_ids = []
positions = set()
for entry in entries:
    parts = entry.split(":")
    if len(parts) == 5 and parts[4].isdigit():
        instance_ids.append(int(parts[4]))
    if len(parts) == 5 and parts[0] == "panel1" and parts[1] == "right" and parts[2].isdigit():
        positions.add(int(parts[2]))
instance_id = max(instance_ids + [0]) + 1

slot = int(position)
while slot in positions:
    slot += 1

entries.append("panel1:right:%d:%s:%d" % (slot, uuid, instance_id))
literal = "[" + ", ".join("'%s'" % entry for entry in entries) + "]"
subprocess.run(["gsettings", "set", schema, key, literal], check=True)
print("added panel1:right:%d:%s:%d" % (slot, uuid, instance_id))
PY
    echo "Cinnamon loads it immediately; use the applet's context menu -> Configure for settings."
else
    echo "Enable it with: cinnamon-settings applets   (or: gsettings get org.cinnamon enabled-applets)"
fi
