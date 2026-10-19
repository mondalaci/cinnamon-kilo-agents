// Unit and integration tests for the applet's library modules, run under plain
// gjs (no Cinnamon). The mock kilo servers are started by run-tests.sh and
// announced through the environment.
//
//   tests/run-tests.sh          # starts mocks, runs this file, cleans up

const GLib = imports.gi.GLib;

const ROOT = GLib.getenv("KILO_TEST_ROOT");
const APPLET_DIR = GLib.build_filenamev([ROOT, "kilo-agents@laci"]);
imports.searchPath.unshift(APPLET_DIR);

const Client = imports.lib.client;
const KiloClient = imports.lib.client.KiloClient;
const Discovery = imports.lib.discovery;
const Format = imports.lib.format;
const Monitor = imports.lib.monitor.Monitor;
const AgentIcon = imports.lib.agenticon;
const Procfs = imports.lib.procfs;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
    checks++;
    if (condition) {
        print("ok   - " + name);
    } else {
        failures++;
        print("FAIL - " + name + (detail ? "  [" + detail + "]" : ""));
    }
}

function equal(name, actual, expected) {
    check(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

function env(name) {
    let value = GLib.getenv(name);
    if (value === null || value === undefined) {
        throw new Error("missing test environment variable " + name);
    }
    return value;
}

function readFile(path) {
    let [ok, contents] = GLib.file_get_contents(path);
    return ok ? new TextDecoder().decode(contents) : null;
}

function writeFile(path, text) {
    GLib.file_set_contents(path, text);
}

function sleep(ms) {
    return new Promise(function (resolve) { GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, function () { resolve(); return GLib.SOURCE_REMOVE; }); });
}

// Resolves with the first model the monitor publishes, and stops it after.
function firstModel(monitor) {
    return new Promise(function (resolve, reject) {
        let guard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, function () {
            reject(new Error("timed out waiting for a model"));
            return GLib.SOURCE_REMOVE;
        });
        monitor.onUpdate = function (model) {
            GLib.source_remove(guard);
            monitor.stop();
            resolve(model);
        };
        monitor.start();
    });
}

function until(condition, timeoutMs) {
    let deadline = Date.now() + (timeoutMs || 15000);
    return (async function poll() {
        while (Date.now() < deadline) {
            if (condition()) {
                return true;
            }
            await sleep(100);
        }
        return false;
    })();
}

// ---------------------------------------------------------------- format

function testFormat() {
    equal("format: truncate keeps short text", Format.truncate("hello", 10), "hello");
    equal("format: truncate ellipsizes", Format.truncate("hello world", 8), "hello w\u2026");
    equal("format: shortDirectory keeps tail", Format.shortDirectory("/home/user/projects/example"), "\u2026/projects/example");
    equal("format: shortDirectory short path", Format.shortDirectory("/tmp"), "/tmp");
    equal("format: modelLabel strips provider", Format.modelLabel({ id: "openrouter/deepseek/deepseek-v4.1-flash" }), "deepseek-v4.1-flash");
    equal("format: modelLabel of string", Format.modelLabel("openrouter/deepseek/deepseek-v4.1-flash"), "deepseek-v4.1-flash");
    equal("format: statusText", Format.statusText("retry"), "retrying");
    equal("format: elapsed seconds", Format.elapsed(4200), "4s");
    equal("format: elapsed minutes", Format.elapsed(125000), "2m");
    equal("format: elapsed hours", Format.elapsed(3700000), "1h1m");
    equal("format: cost small", Format.formatCost(0.0123), "$0.01");
    equal("format: cost tiny", Format.formatCost(0.0004), "$0.0004");
    equal("format: cost zero", Format.formatCost(0), "$0");

    let model = {
        active: 2, busy: 1, retry: 1, offline: 0,
        servers: [{ id: "127.0.0.1:1", ok: true }],
        sessions: [
            { title: "Fix the widget", statusType: "busy", directory: "/home/user/projects/example" },
        ],
        errors: [],
    };
    let tooltip = Format.tooltipText(model, { maxLines: 5, showDirectory: true });
    check("format: tooltip mentions counts", tooltip.indexOf("2 active (1 working, 1 retrying)") >= 0, tooltip);
    check("format: tooltip lists the session", tooltip.indexOf("Fix the widget") >= 0, tooltip);
    check("format: tooltip shows the project", tooltip.indexOf("projects/example") >= 0, tooltip);
}

// ------------------------------------------------------------ agent icons

function testAgentIcon() {
    let ids = AgentIcon.ids();
    check("icons: shipped set", ids.length === 8, ids.join(","));
    check("icons: default is one of them", ids.indexOf(AgentIcon.DEFAULT_ID) >= 0, AgentIcon.DEFAULT_ID);
    check("icons: default is the chosen one", AgentIcon.DEFAULT_ID === "lucide-bot", AgentIcon.DEFAULT_ID);
    equal("icons: ids are unique", Object.keys(ids.reduce(function (acc, id) { acc[id] = 1; return acc; }, {})).length, ids.length);

    // the settings dropdown offers exactly the shipped icons
    let options = AgentIcon.options();
    equal("icons: dropdown option count", Object.keys(options).length, ids.length);
    let offered = Object.keys(options).map(function (label) { return options[label]; }).sort();
    equal("icons: dropdown matches the shipped ids", offered.join(","), ids.slice().sort().join(","));

    // every shipped file exists, is an SVG, and carries a concrete colour
    let missing = [];
    let bad = [];
    let coloured = 0;
    for (let i = 0; i < ids.length; i++) {
        let path = AgentIcon.pathFor(ids[i], APPLET_DIR);
        let text = readFile(path);
        if (text === null) {
            missing.push(ids[i]);
            continue;
        }
        let problems = [];
        if (text.indexOf("<svg") < 0) {
            problems.push("no <svg");
        }
        if (text.indexOf("currentColor") >= 0) {
            problems.push("still uses currentColor");
        }
        if (text.indexOf("#c6cdd6") < 0) {
            problems.push("not in the panel colour");
        }
        if (text.indexOf("licen") < 0 && text.indexOf("(MIT)") < 0 && text.indexOf("(ISC)") < 0 && text.indexOf("Apache") < 0) {
            problems.push("no licence note");
        }
        if (problems.length) {
            bad.push(ids[i] + ": " + problems.join(", "));
        } else {
            coloured++;
        }
    }
    equal("icons: every icon file exists", missing.join(","), "");
    equal("icons: every icon is a tinted SVG with its licence", bad.join("; "), "");
    equal("icons: checked files", coloured, ids.length);

    // paths stay inside the applet
    let path = AgentIcon.pathFor("lucide-bot", APPLET_DIR + "/");
    check("icons: path is inside the applet", path.indexOf(APPLET_DIR + "/icons/") === 0, path);
    equal("icons: unknown id falls back to the default", AgentIcon.pathFor("nope", APPLET_DIR),
        AgentIcon.pathFor(AgentIcon.DEFAULT_ID, APPLET_DIR));
    equal("icons: labels resolve", AgentIcon.labelFor("lucide-bot"), "Lucide bot");
    equal("icons: unknown label falls back", AgentIcon.labelFor("nope"), "Lucide bot");
    check("icons: theme fallback name", AgentIcon.FALLBACK_ICON_NAME.indexOf("symbolic") > 0, AgentIcon.FALLBACK_ICON_NAME);

    // the settings schema offers the same icons as the module, with the same default
    let schema = JSON.parse(readFile(APPLET_DIR + "/settings-schema.json"));
    let schemaIds = Object.keys(schema["agent-icon"].options).map(function (label) { return schema["agent-icon"].options[label]; }).sort();
    equal("icons: schema options match the module", schemaIds.join(","), ids.slice().sort().join(","));
    equal("icons: schema default matches", schema["agent-icon"].default, AgentIcon.DEFAULT_ID);
}

// ------------------------------------------------------------- discovery

function testServerSpecs() {
    let servers = Discovery.parseExtraServers("127.0.0.1:4096\n# comment\nhttp://127.0.0.1:27183\n\n10.0.0.5:9999:kilo:s3cret\n");
    equal("discovery: parsed extra servers", servers.length, 3);
    equal("discovery: first host", servers[0].host, "127.0.0.1");
    equal("discovery: first port", servers[0].port, 4096);
    equal("discovery: url form port", servers[1].port, 27183);
    equal("discovery: credentials parsed", servers[2].password, "s3cret");
    equal("discovery: default username", servers[0].username, "kilo");
    equal("discovery: id", servers[0].id, "127.0.0.1:4096");
    equal("discovery: garbage ignored", Discovery.parseExtraServers("nonsense").length, 0);
}

function testDaemonFile() {
    let path = GLib.build_filenamev([env("KILO_TEST_WORK"), "daemon.json"]);
    writeFile(path, JSON.stringify({
        pid: 4242,
        port: parseInt(env("KILO_TEST_DAEMON_PORT"), 10),
        urls: { local: "http://127.0.0.1:" + env("KILO_TEST_DAEMON_PORT"), network: "" },
        username: "kilo",
        password: "daemon-secret",
        version: "9.9.9",
    }));
    let servers = Discovery.fromDaemonFile(path);
    equal("discovery: daemon file parsed", servers.length, 1);
    equal("discovery: daemon port", servers[0].port, parseInt(env("KILO_TEST_DAEMON_PORT"), 10));
    equal("discovery: daemon password", servers[0].password, "daemon-secret");
    equal("discovery: daemon source", servers[0].source, "daemon");

    let broken = GLib.build_filenamev([env("KILO_TEST_WORK"), "daemon-broken.json"]);
    writeFile(broken, "{not json");
    equal("discovery: broken daemon file ignored", Discovery.fromDaemonFile(broken).length, 0);
    equal("discovery: missing daemon file ignored", Discovery.fromDaemonFile("/nonexistent/daemon.json").length, 0);
}

function testProcDiscovery() {
    let servers = Discovery.fromProc({ includeMocks: true });
    let ports = servers.map(function (server) { return server.port; });
    let fixedPort = parseInt(env("KILO_TEST_FIXED_PORT"), 10);
    let dynamicPort = parseInt(readFile(env("KILO_TEST_DYNAMIC_PORT_FILE")), 10);

    check("proc: fixed-port server found (" + fixedPort + ")", ports.indexOf(fixedPort) >= 0, ports.join(","));
    check("proc: --port 0 server resolved via /proc/net/tcp (" + dynamicPort + ")", ports.indexOf(dynamicPort) >= 0, ports.join(","));

    let byPort = {};
    for (let i = 0; i < servers.length; i++) {
        byPort[servers[i].port] = servers[i];
    }
    check("proc: password-less server has no password", byPort[fixedPort] && byPort[fixedPort].password === null,
        byPort[fixedPort] ? String(byPort[fixedPort].password) : "missing");
    equal("proc: password read from environ", byPort[dynamicPort] && byPort[dynamicPort].password, "test-secret-123");
    equal("proc: source", byPort[fixedPort] && byPort[fixedPort].source, "proc");
    check("proc: pid recorded", byPort[fixedPort] && byPort[fixedPort].pid > 0, String(byPort[fixedPort] && byPort[fixedPort].pid));
    check("proc: our own process is not reported", ports.indexOf(Procfs.selfPid()) < 0, String(Procfs.selfPid()));
}

async function testMocksAreSkipped() {
    let fixedPort = parseInt(env("KILO_TEST_FIXED_PORT"), 10);
    let dynamicPort = parseInt(readFile(env("KILO_TEST_DYNAMIC_PORT_FILE")), 10);

    // what the applet does: no markers, so no test double may show up
    let appletView = Discovery.discover({ useDaemon: false, useProc: true, extraServers: "" });
    let ports = appletView.map(function (server) { return server.port; });
    check("mocks: fixed-port double is skipped", ports.indexOf(fixedPort) < 0, ports.join(","));
    check("mocks: dynamic-port double is skipped", ports.indexOf(dynamicPort) < 0, ports.join(","));

    // the doubles really are running and reachable - the skip is what hides them
    let client = new KiloClient({ host: "127.0.0.1", port: fixedPort });
    let projects = await client.projects();
    check("mocks: the skipped double still answers", projects.length === 2, JSON.stringify(projects.length));

    // and the test suite can still see them on request
    let testing = Discovery.discover({ useDaemon: false, useProc: true, extraServers: "", includeMocks: true });
    let testingPorts = testing.map(function (server) { return server.port; });
    check("mocks: opt-in brings them back", testingPorts.indexOf(fixedPort) >= 0 && testingPorts.indexOf(dynamicPort) >= 0,
        testingPorts.join(","));
}

function testMerge() {
    let servers = Discovery.discover({
        useDaemon: true,
        daemonFile: GLib.build_filenamev([env("KILO_TEST_WORK"), "daemon.json"]),
        useProc: true,
        extraServers: "127.0.0.1:" + env("KILO_TEST_FIXED_PORT") + "\n127.0.0.1:1",
        includeMocks: true,
    });
    let ids = servers.map(function (server) { return server.id; });
    let fixedId = "127.0.0.1:" + env("KILO_TEST_FIXED_PORT");
    equal("discovery: duplicates merged", ids.filter(function (id) { return id === fixedId; }).length, 1);
    check("discovery: proc server kept", ids.indexOf(fixedId) >= 0, ids.join(","));
    check("discovery: daemon server kept", ids.indexOf("127.0.0.1:" + env("KILO_TEST_DAEMON_PORT")) >= 0, ids.join(","));
    check("discovery: configured-only server kept", ids.indexOf("127.0.0.1:1") >= 0, ids.join(","));
    check("discovery: sorted by port", servers.length > 1 && servers[0].port <= servers[servers.length - 1].port, ids.join(","));
}

// ---------------------------------------------------------------- client

async function testClient() {
    let fixedPort = parseInt(env("KILO_TEST_FIXED_PORT"), 10);
    let dynamicPort = parseInt(readFile(env("KILO_TEST_DYNAMIC_PORT_FILE")), 10);
    let stateFile = env("KILO_TEST_STATE");

    let open = new KiloClient({ host: "127.0.0.1", port: fixedPort });
    let projects = await open.projects();
    check("client: /project returns the mocked projects", projects.length === 2, JSON.stringify(projects));

    let statuses = await open.sessionStatuses(env("KILO_TEST_PROJ_A"));
    equal("client: status for a busy project", statuses["ses_busy_a"] && statuses["ses_busy_a"].type, "busy");
    equal("client: unknown directory is empty", Object.keys(await open.sessionStatuses("/nope")).length, 0);
    equal("client: bare status is empty (like the real server)",
        Object.keys(await open.sessionStatuses(null)).length, 0);

    let sessions = await open.sessions(env("KILO_TEST_PROJ_A"), 10);
    check("client: /api/session returns data array", Array.isArray(sessions) && sessions.length >= 1, JSON.stringify(sessions.length));
    equal("client: session title joined", sessions[0].title, "Fix the widget");

    let auth = new KiloClient({ host: "127.0.0.1", port: dynamicPort });
    let unauthorized = null;
    try {
        await auth.projects();
    } catch (e) {
        unauthorized = e;
    }
    check("client: 401 without credentials", unauthorized !== null && unauthorized.status === 401,
        unauthorized ? String(unauthorized.status) : "no error");

    let authenticated = new KiloClient({ host: "127.0.0.1", port: dynamicPort, username: "kilo", password: "test-secret-123" });
    let projects2 = await authenticated.projects();
    equal("client: authenticated request works", projects2.length, 2);

    let missing = new KiloClient({ host: "127.0.0.1", port: fixedPort });
    let error404 = null;
    try {
        await missing.getJson("/nope");
    } catch (e) {
        error404 = e;
    }
    check("client: 404 raises", error404 !== null && error404.status === 404, error404 ? String(error404.status) : "no error");

    let dead = new KiloClient({ host: "127.0.0.1", port: parseInt(env("KILO_TEST_DEAD_PORT"), 10), timeoutSeconds: 2 });
    let refused = null;
    try {
        await dead.projects();
    } catch (e) {
        refused = e;
    }
    check("client: connection refused raises", refused !== null, String(refused));

    check("client: test state file is used", readFile(stateFile) !== null);
}

// --------------------------------------------------------------- monitor

function monitorOptions(overrides) {
    let options = {
        intervalSeconds: 1,
        maxSessions: 20,
        maxDirectories: 20,
        metadataTtlSeconds: 1,
        discoverOptions: {
            useDaemon: false,
            useProc: false,
            extraServers: "",
        },
        log: function () {},
        onError: function (e) { print("monitor error: " + e.message); },
    };
    for (let key in (overrides || {})) {
        options[key] = overrides[key];
    }
    return options;
}

async function testMonitorWithProcDiscovery() {
    let monitor = new Monitor(monitorOptions({
        discoverOptions: { useDaemon: false, useProc: true, extraServers: "", includeMocks: true },
    }));
    let model = await firstModel(monitor);

    let fixedPort = parseInt(env("KILO_TEST_FIXED_PORT"), 10);
    let dynamicPort = parseInt(readFile(env("KILO_TEST_DYNAMIC_PORT_FILE")), 10);
    let serverIds = model.servers.map(function (server) { return server.id; });
    check("monitor: discovered both mock servers", serverIds.length >= 2, serverIds.join(","));

    let byId = {};
    for (let i = 0; i < model.servers.length; i++) {
        byId[model.servers[i].id] = model.servers[i];
    }
    let fixed = byId["127.0.0.1:" + fixedPort];
    let dynamic = byId["127.0.0.1:" + dynamicPort];
    check("monitor: unauthenticated server reachable", fixed && fixed.ok, fixed ? String(fixed.error) : "missing");
    check("monitor: authenticated server reachable (password from /proc)", dynamic && dynamic.ok,
        dynamic ? String(dynamic.error) : "missing");

    let busy = model.sessions.filter(function (session) { return session.id === "ses_busy_a"; })[0];
    check("monitor: busy session present", !!busy);
    if (busy) {
        equal("monitor: status type", busy.statusType, "busy");
        equal("monitor: metadata joined (title)", busy.title, "Fix the widget");
        equal("monitor: metadata joined (agent)", busy.agent, "code");
        equal("monitor: metadata joined (model)", busy.model, "openrouter/deepseek-v4.1-flash");
        equal("monitor: directory from session info", busy.directory, env("KILO_TEST_PROJ_A"));
        check("monitor: server attribution", busy.serverId === "127.0.0.1:" + fixedPort, busy.serverId);
        check("monitor: updated timestamp joined", busy.updated > 0, String(busy.updated));
    }

    let retrying = model.sessions.filter(function (session) { return session.id === "ses_retry_b"; })[0];
    check("monitor: retry session present", !!retrying);
    if (retrying) {
        equal("monitor: retry counted", model.retry >= 1, true);
        check("monitor: retry details", retrying.attempt === 2 && retrying.nextAt === 2000,
            retrying.attempt + "/" + retrying.nextAt);
        check("monitor: retry detail text", Format.statusDetail(retrying).indexOf("attempt 2") >= 0, Format.statusDetail(retrying));
        check("monitor: authenticated server contributes its sessions",
            retrying.serverId === "127.0.0.1:" + dynamicPort, retrying.serverId);
    }

    let offline = model.sessions.filter(function (session) { return session.id === "ses_offline_c"; })[0];
    check("monitor: offline session present", !!offline);
    if (offline) {
        equal("monitor: offline counted", model.offline, 1);
        check("monitor: offline detail", Format.statusDetail(offline).indexOf("awaiting answer") >= 0, Format.statusDetail(offline));
    }

    equal("monitor: active total", model.active, model.busy + model.retry + model.offline);
    check("monitor: idle sessions excluded", model.sessions.every(function (s) { return s.statusType !== "idle"; }));
    // ses_shared_x lives in both mock servers' state on purpose: the model must
    // hold exactly one row for it and record both reporting servers.
    let shared = model.sessions.filter(function (session) { return session.id === "ses_shared_x"; });
    equal("monitor: duplicate session rows merged", shared.length, 1);
    check("monitor: merged row records both servers",
        shared.length === 1 && (shared[0].reportedBy || []).indexOf("127.0.0.1:" + fixedPort) >= 0 &&
        (shared[0].reportedBy || []).indexOf("127.0.0.1:" + dynamicPort) >= 0,
        shared.length === 1 ? JSON.stringify(shared[0].reportedBy) : "no row");
    equal("monitor: counts are post-deduplication", model.offline, 1);
    check("monitor: busy sorts first", model.busy === 0 || model.sessions[0].statusType === "busy", model.sessions.map(function (s) { return s.statusType; }).join(","));
    check("monitor: no errors for the mock servers",
        !model.errors.some(function (message) { return message.indexOf(String(fixedPort)) >= 0 || message.indexOf(String(dynamicPort)) >= 0; }),
        model.errors.join("; "));
    return model;
}

async function testMonitorExtraServersAndErrors() {
    let deadPort = parseInt(env("KILO_TEST_DEAD_PORT"), 10);
    let fixedPort = env("KILO_TEST_FIXED_PORT");
    let dynamicPort = readFile(env("KILO_TEST_DYNAMIC_PORT_FILE")).trim();
    let monitor = new Monitor(monitorOptions({
        discoverOptions: {
            useDaemon: false,
            useProc: false,
            extraServers: "127.0.0.1:" + fixedPort + "\n127.0.0.1:" + dynamicPort + ":kilo:test-secret-123\n127.0.0.1:" + deadPort,
        },
    }));
    let model = await firstModel(monitor);

    equal("monitor: three configured servers", model.servers.length, 3);
    let dead = model.servers.filter(function (server) { return server.port === deadPort; })[0];
    check("monitor: dead server reported", !!dead && dead.ok === false, dead ? String(dead.error) : "missing");
    check("monitor: dead server error surfaced", model.errors.length === 1, model.errors.join("; "));
    check("monitor: other servers unaffected", model.servers.filter(function (server) { return server.ok; }).length === 2,
        model.servers.map(function (s) { return s.id + "=" + s.ok; }).join(","));
    check("monitor: sessions from reachable servers only", model.active >= 1, String(model.active));
    let authenticated = model.servers.filter(function (server) { return server.port === parseInt(dynamicPort, 10); })[0];
    check("monitor: authenticated server via config password", authenticated && authenticated.ok,
        authenticated ? String(authenticated.error) : "missing");
}

async function testMonitorReactsToStateChanges() {
    let stateFile = env("KILO_TEST_STATE");
    let original = readFile(stateFile);

    let monitor = new Monitor(monitorOptions({
        intervalSeconds: 1,
        discoverOptions: {
            useDaemon: true,
            daemonFile: GLib.build_filenamev([env("KILO_TEST_WORK"), "daemon.json"]),
            useProc: true,
            extraServers: "",
            includeMocks: true,
        },
    }));

    let models = [];
    let resolveSecond = null;
    let secondModel = new Promise(function (resolve) { resolveSecond = resolve; });
    monitor.onUpdate = function (model) {
        models.push(model);
        if (models.length === 2) {
            resolveSecond(model);
        }
    };
    monitor.start();
    check("monitor: first sweep arrives", await until(function () { return models.length >= 1; }, 20000), "no model");

    // ses_busy_a stops working, ses_new_a starts, and the daemon server gets a
    // busy session of its own.
    let state = JSON.parse(original);
    state.sessions[0].status = { type: "idle" };
    state.sessions.push({
        id: "ses_new_a",
        directory: env("KILO_TEST_PROJ_A"),
        status: { type: "busy" },
        title: "Second session",
        agent: "ask",
    });
    writeFile(stateFile, JSON.stringify(state));

    let model = await secondModel;
    monitor.stop();

    let ids = model.sessions.map(function (session) { return session.id; });
    check("monitor: finished session dropped", ids.indexOf("ses_busy_a") < 0, ids.join(","));
    check("monitor: new session picked up without restart", ids.indexOf("ses_new_a") >= 0, ids.join(","));
    let fresh = model.sessions.filter(function (session) { return session.id === "ses_new_a"; })[0];
    equal("monitor: new session metadata", fresh && fresh.title, "Second session");
    equal("monitor: daemon server contributes sessions", model.sessions.filter(function (session) { return session.id === "ses_daemon_d"; }).length, 1);
    check("monitor: daemon server marked ok", model.servers.filter(function (server) { return server.port === parseInt(env("KILO_TEST_DAEMON_PORT"), 10); })[0].ok === true);

    writeFile(stateFile, original);
}

async function testMonitorStop() {
    let monitor = new Monitor(monitorOptions({ intervalSeconds: 1 }));
    let count = 0;
    monitor.onUpdate = function () { count++; };
    monitor.start();
    await until(function () { return count >= 1; }, 20000);
    monitor.stop();
    let afterStop = count;
    await sleep(2500);
    equal("monitor: no sweeps after stop", count, afterStop);
    check("monitor: running flag cleared", monitor.running === false);
}

// ------------------------------------------------------------------ main

async function run() {
    print("libsoup major version: " + Client.LIBSOUP_MAJOR + ", send_and_read_async: " + Client.HAS_SEND_AND_READ);

    testFormat();
    testAgentIcon();
    testServerSpecs();
    testDaemonFile();

    let anyKilo = Discovery.fromProc({ includeMocks: true });
    check("proc: finds kilo-ish processes at all", anyKilo.length >= 2, "found " + anyKilo.length);
    testProcDiscovery();
    testMerge();
    await testMocksAreSkipped();

    await testClient();
    await testMonitorWithProcDiscovery();
    await testMonitorExtraServersAndErrors();
    await testMonitorReactsToStateChanges();
    await testMonitorStop();

    print("");
    print(checks + " checks, " + failures + " failures");
    return failures === 0;
}

let loop = new GLib.MainLoop(null, false);
let ok = false;
run().then(function (result) {
    ok = result;
}, function (error) {
    print("ERROR: " + error.message);
    print(error.stack ? error.stack : "");
}).then(function () {
    loop.quit();
});
loop.run();

if (!ok) {
    imports.system.exit(1);
}
