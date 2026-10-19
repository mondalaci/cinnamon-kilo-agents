#!/usr/bin/env bash
# Remove the Kilo Agents applet from Cinnamon: panel entry, config, files.

set -euo pipefail

UUID="kilo-agents@laci"
DEST_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/applets"
DEST="$DEST_ROOT/$UUID"
# Cinnamon 6 keeps xlet settings under ~/.config/cinnamon/spices,
# older versions under ~/.cinnamon/configs.
DATA_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIRS=("$DATA_HOME/cinnamon/spices/$UUID" "$HOME/.cinnamon/configs/$UUID")
KEEP_FILES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --keep-files) KEEP_FILES=1 ;;
        -h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

python3 - "$UUID" <<'PY'
import ast
import subprocess
import sys

uuid = sys.argv[1]
schema, key = "org.cinnamon", "enabled-applets"
raw = subprocess.run(["gsettings", "get", schema, key],
                     capture_output=True, text=True, check=True).stdout
entries = [entry for entry in ast.literal_eval(raw) if uuid not in entry]
literal = "[" + ", ".join("'%s'" % entry for entry in entries) + "]"
subprocess.run(["gsettings", "set", schema, key, literal], check=True)
print("removed the panel entry (%d applets left)" % len(entries))
PY

if [ "$KEEP_FILES" = "0" ]; then
    rm -rf "$DEST" "${CONFIG_DIRS[@]}"
    echo "removed $DEST and ${CONFIG_DIRS[*]}"
else
    echo "kept $DEST and ${CONFIG_DIRS[*]}"
fi
