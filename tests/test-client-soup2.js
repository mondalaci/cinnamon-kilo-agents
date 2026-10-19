// Verifies that the HTTP client also works on libsoup 2.4 (Cinnamon 5.x),
// which the feature-detecting client falls back to. Run in its own gjs
// process so the version pin happens before Soup is imported.

imports.gi.versions.Soup = "2.4";

const GLib = imports.gi.GLib;

const ROOT = GLib.getenv("KILO_TEST_ROOT");
imports.searchPath.unshift(GLib.build_filenamev([ROOT, "kilo-agents@laci"]));

const Client = imports.lib.client;
const KiloClient = imports.lib.client.KiloClient;

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
    return GLib.getenv(name);
}

function readFile(path) {
    let [ok, contents] = GLib.file_get_contents(path);
    return ok ? new TextDecoder().decode(contents) : null;
}

async function run() {
    print("libsoup major version: " + Client.LIBSOUP_MAJOR + ", send_and_read_async: " + Client.HAS_SEND_AND_READ);
    equal("soup2: libsoup 2.x is in use", Client.LIBSOUP_MAJOR, 2);
    equal("soup2: send_and_read_async absent", Client.HAS_SEND_AND_READ, false);

    let fixedPort = parseInt(env("KILO_TEST_FIXED_PORT"), 10);
    let dynamicPort = parseInt(readFile(env("KILO_TEST_DYNAMIC_PORT_FILE")), 10);

    let open = new KiloClient({ host: "127.0.0.1", port: fixedPort });
    let projects = await open.projects();
    equal("soup2: /project works", projects.length, 2);

    let statuses = await open.sessionStatuses(env("KILO_TEST_PROJ_A"));
    equal("soup2: /session/status works", statuses["ses_busy_a"] && statuses["ses_busy_a"].type, "busy");

    let sessions = await open.sessions(env("KILO_TEST_PROJ_A"), 5);
    equal("soup2: /api/session works", sessions.length >= 1, true);
    equal("soup2: session title", sessions[0].title, "Fix the widget");

    let anonymous = new KiloClient({ host: "127.0.0.1", port: dynamicPort });
    let unauthorized = null;
    try {
        await anonymous.projects();
    } catch (e) {
        unauthorized = e;
    }
    check("soup2: 401 without credentials", unauthorized !== null && unauthorized.status === 401,
        unauthorized ? String(unauthorized.status) : "no error");

    let authenticated = new KiloClient({ host: "127.0.0.1", port: dynamicPort, username: "kilo", password: "test-secret-123" });
    equal("soup2: authenticated request works", (await authenticated.projects()).length, 2);

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
