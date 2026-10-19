// Finding the kilo servers that are running on this machine.
//
// Kilo's "who is working" state lives in the memory of the server process
// that runs an agent, not in the shared database, so an applet has to talk to
// every server process it can find. Three sources, cheapest first:
//
//   1. kilo daemon discovery file (~/.local/state/kilo/daemon.json)
//   2. servers the user listed in the applet settings
//   3. a /proc scan - each `kilo serve` (including the VS Code extension's
//      random-port ones) carries KILO_* variables in its environment; the
//      port comes from --port, or from the process's listening sockets when
//      it was started with `--port 0`.

const GLib = imports.gi.GLib;

const Procfs = imports.lib.procfs;

var DEFAULT_HOST = "127.0.0.1";
var DEFAULT_USERNAME = "kilo";

function defaultDaemonFile() {
    return GLib.build_filenamev([GLib.get_home_dir(), ".local", "state", "kilo", "daemon.json"]);
}

function makeServer(fields) {
    let server = {
        host: fields.host || DEFAULT_HOST,
        port: parseInt(fields.port, 10),
        username: fields.username || DEFAULT_USERNAME,
        password: fields.password || null,
        source: fields.source || "unknown",
        pid: fields.pid || null,
        cmdline: fields.cmdline || null,
        cwd: fields.cwd || null,
    };
    if (!server.port || isNaN(server.port)) {
        return null;
    }
    server.id = server.host + ":" + server.port;
    return server;
}

function label(server) {
    let text = server.id;
    if (server.pid) {
        text += " (pid " + server.pid + ")";
    }
    return text;
}

function parseUrl(text) {
    let match = /^(?:https?:\/\/)?([^\/:]+)(?::(\d+))?/.exec(text.trim());
    if (!match) {
        return null;
    }
    return { host: match[1], port: match[2] ? parseInt(match[2], 10) : null };
}

// "host:port", "host:port:username:password" or "http://host:port".
function parseServerSpec(text) {
    let spec = text.trim();
    if (!spec || spec.startsWith("#")) {
        return null;
    }
    let parsed = parseUrl(spec);
    if (!parsed || !parsed.port) {
        return null;
    }
    let rest = spec.replace(/^(?:https?:\/\/)?[^\/:]+:\d+/, "");
    let credentials = rest.replace(/^[:\s]+/, "").split(":");
    return makeServer({
        host: parsed.host,
        port: parsed.port,
        username: credentials.length > 0 && credentials[0] ? credentials[0] : DEFAULT_USERNAME,
        password: credentials.length > 1 && credentials[1] ? credentials[1] : null,
        source: "config",
    });
}

function parseExtraServers(text) {
    if (!text) {
        return [];
    }
    let servers = [];
    let lines = text.split(/[\n,]/);
    for (let i = 0; i < lines.length; i++) {
        let server = parseServerSpec(lines[i]);
        if (server) {
            servers.push(server);
        }
    }
    return servers;
}

function fromDaemonFile(path, options) {
    let file = path || defaultDaemonFile();
    let text = Procfs.readText(file);
    if (!text) {
        return [];
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        if (options && options.log) {
            options.log("kilo-agents: ignoring unreadable daemon file " + file + ": " + e.message);
        }
        return [];
    }
    let host = DEFAULT_HOST;
    let port = data.port;
    if (data.urls && data.urls.local) {
        let parsed = parseUrl(data.urls.local);
        if (parsed) {
            host = parsed.host || host;
            port = port || parsed.port;
        }
    } else if (data.url) {
        let parsed = parseUrl(data.url);
        if (parsed) {
            host = parsed.host || host;
            port = port || parsed.port;
        }
    }
    if (data.hostname && (data.hostname === "localhost" || data.hostname === "127.0.0.1")) {
        host = data.hostname === "localhost" ? DEFAULT_HOST : data.hostname;
    }
    let server = makeServer({
        host: host,
        port: port,
        username: data.username,
        password: data.password,
        pid: data.pid,
        source: "daemon",
    });
    return server ? [server] : [];
}

function flagValue(argv, flag) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === flag && i + 1 < argv.length) {
            return argv[i + 1];
        }
        if (argv[i].startsWith(flag + "=")) {
            return argv[i].slice(flag.length + 1);
        }
    }
    return null;
}

function hasToken(argv, token) {
    return argv.indexOf(token) >= 0;
}

// Test doubles started by tests/bin/kilo carry this marker so that running the
// test suite cannot pollute a live panel.
var MOCK_MARKER = "KILO_AGENTS_MOCK";

function isMock(env) {
    return !!(env && env[MOCK_MARKER]);
}

function looksLikeKiloEnv(env) {
    if (!env) {
        return false;
    }
    if (env.KILO || env.KILO_MACHINE_ID) {
        return true;
    }
    for (let key in env) {
        if (key.startsWith("KILO_SERVER") || key.startsWith("KILOCODE")) {
            return true;
        }
    }
    return false;
}

// Every `kilo serve` process owned by the current user.
// options: { includeMocks } - the applet leaves that false, the test suite sets it.
function fromProc(options) {
    let opts = options || {};
    let self = Procfs.selfPid();
    let servers = [];
    let pids = Procfs.pidList();
    for (let i = 0; i < pids.length; i++) {
        let pid = pids[i];
        if (pid === self) {
            continue;
        }
        let argv = Procfs.cmdline(pid);
        if (!argv || !hasToken(argv, "serve")) {
            continue;
        }
        let env = Procfs.environ(pid);
        if (!looksLikeKiloEnv(env)) {
            continue;
        }
        if (!opts.includeMocks && isMock(env)) {
            continue;
        }

        let hosts = [];
        let hostname = flagValue(argv, "--hostname") || flagValue(argv, "--host");
        if (hostname) {
            hosts.push(hostname === "0.0.0.0" ? DEFAULT_HOST : hostname);
        }
        let port = parseInt(flagValue(argv, "--port") || "", 10);
        if (isNaN(port) || port <= 0) {
            // `--port 0` means "pick one": ask the kernel what it picked.
            let ports = Procfs.pidListeningPorts(pid);
            if (opts.log && ports.length === 0) {
                opts.log("kilo-agents: pid " + pid + " speaks serve but listens on nothing (yet)");
            }
            for (let p = 0; p < ports.length; p++) {
                let server = makeServer({
                    host: hosts.length ? hosts[0] : DEFAULT_HOST,
                    port: ports[p],
                    username: env.KILO_SERVER_USERNAME,
                    password: env.KILO_SERVER_PASSWORD,
                    pid: pid,
                    cmdline: argv.join(" "),
                    cwd: Procfs.cwd(pid),
                    source: "proc",
                });
                if (server) {
                    servers.push(server);
                }
            }
            continue;
        }

        let server = makeServer({
            host: hosts.length ? hosts[0] : DEFAULT_HOST,
            port: port,
            username: env.KILO_SERVER_USERNAME,
            password: env.KILO_SERVER_PASSWORD,
            pid: pid,
            cmdline: argv.join(" "),
            cwd: Procfs.cwd(pid),
            source: "proc",
        });
        if (server) {
            servers.push(server);
        }
    }
    return servers;
}

// Merge by host:port, preferring the entry that carries credentials.
function merge(servers) {
    let byId = {};
    let order = [];
    for (let i = 0; i < servers.length; i++) {
        let server = servers[i];
        let existing = byId[server.id];
        if (!existing) {
            byId[server.id] = server;
            order.push(server.id);
            continue;
        }
        if (!existing.password && server.password) {
            existing.password = server.password;
            existing.username = server.username;
            existing.source = existing.source + "+" + server.source;
        }
        if (!existing.pid && server.pid) {
            existing.pid = server.pid;
        }
    }
    return order.map(function (id) { return byId[id]; });
}

// options: { daemonFile, useDaemon, useProc, extraServers, includeMocks, log }
function discover(options) {
    let opts = options || {};
    let found = [];

    if (opts.useDaemon !== false) {
        found = found.concat(fromDaemonFile(opts.daemonFile, opts));
    }
    found = found.concat(parseExtraServers(opts.extraServers));
    if (opts.useProc !== false) {
        found = found.concat(fromProc(opts));
    }

    let servers = merge(found);
    servers.sort(function (a, b) { return a.port - b.port; });
    return servers;
}
