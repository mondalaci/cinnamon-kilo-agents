// Low-level /proc and filesystem helpers used for server discovery.
//
// Deliberately free of Cinnamon and libsoup dependencies so the module can be
// loaded (and exercised) from a plain `gjs` process in the test suite.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

// TCP state for LISTEN sockets in /proc/net/tcp{,6}.
var LISTEN_STATE = "0A";

function readBytes(path) {
    try {
        let [ok, contents] = GLib.file_get_contents(path);
        return ok ? contents : null;
    } catch (e) {
        return null;
    }
}

function readText(path) {
    let bytes = readBytes(path);
    if (!bytes) {
        return null;
    }
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

function readLink(path) {
    try {
        return GLib.file_read_link(path);
    } catch (e) {
        return null;
    }
}

function exists(path) {
    try {
        return GLib.file_test(path, GLib.FileTest.EXISTS);
    } catch (e) {
        return false;
    }
}

function selfPid() {
    let link = readLink("/proc/self");
    if (!link) {
        return null;
    }
    let pid = parseInt(link, 10);
    return isNaN(pid) ? null : pid;
}

function pidList() {
    let pids = [];
    try {
        let dir = Gio.File.new_for_path("/proc");
        let iter = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = iter.next_file(null)) !== null) {
            let name = info.get_name();
            if (/^[0-9]+$/.test(name)) {
                pids.push(parseInt(name, 10));
            }
        }
        iter.close(null);
    } catch (e) {
        // /proc unreadable (container, hidepid) - caller gets an empty list.
    }
    return pids;
}

// argv of a process as an array, or null when unreadable.
function cmdline(pid) {
    let text = readText("/proc/" + pid + "/cmdline");
    if (text === null) {
        return null;
    }
    return text.split("\0").filter(function (part) { return part.length > 0; });
}

// Environment of a process as an object, or null when unreadable.
function environ(pid) {
    let text = readText("/proc/" + pid + "/environ");
    if (text === null) {
        return null;
    }
    let env = {};
    let parts = text.split("\0");
    for (let i = 0; i < parts.length; i++) {
        let entry = parts[i];
        if (!entry) {
            continue;
        }
        let eq = entry.indexOf("=");
        if (eq <= 0) {
            continue;
        }
        env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
}

function cwd(pid) {
    return readLink("/proc/" + pid + "/cwd");
}

// inode -> { port, family, address } for every listening TCP socket.
function listenInodes() {
    let map = {};
    let files = ["/proc/net/tcp", "/proc/net/tcp6"];
    for (let f = 0; f < files.length; f++) {
        let text = readText(files[f]);
        if (!text) {
            continue;
        }
        let lines = text.split("\n");
        for (let i = 1; i < lines.length; i++) {
            let parts = lines[i].trim().split(/\s+/);
            if (parts.length < 10 || parts[3] !== LISTEN_STATE) {
                continue;
            }
            let local = parts[1];
            let colon = local.lastIndexOf(":");
            if (colon < 0) {
                continue;
            }
            let port = parseInt(local.slice(colon + 1), 16);
            if (isNaN(port)) {
                continue;
            }
            map[parts[9]] = {
                port: port,
                family: files[f].indexOf("tcp6") >= 0 ? 6 : 4,
                address: local.slice(0, colon),
            };
        }
    }
    return map;
}

// Socket inodes held by a process, as strings.
function pidSocketInodes(pid) {
    let inodes = [];
    try {
        let dir = Gio.File.new_for_path("/proc/" + pid + "/fd");
        let iter = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = iter.next_file(null)) !== null) {
            let link = readLink("/proc/" + pid + "/fd/" + info.get_name());
            if (!link) {
                continue;
            }
            let match = /^socket:\[(\d+)\]$/.exec(link);
            if (match) {
                inodes.push(match[1]);
            }
        }
        iter.close(null);
    } catch (e) {
        // Not our process, or it exited mid-scan.
    }
    return inodes;
}

// Every TCP port a process is listening on (needed for `serve --port 0`).
function pidListeningPorts(pid) {
    let inodes = listenInodes();
    let sockets = pidSocketInodes(pid);
    let ports = [];
    for (let i = 0; i < sockets.length; i++) {
        let entry = inodes[sockets[i]];
        if (entry && ports.indexOf(entry.port) < 0) {
            ports.push(entry.port);
        }
    }
    return ports;
}
