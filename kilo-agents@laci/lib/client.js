// Minimal async HTTP client for the Kilo server API.
//
// Works with whichever libsoup flavour the running Cinnamon loaded: libsoup3
// (Soup.Session.send_and_read_async, what Cinnamon 6.x links against) or
// libsoup2.4 (Soup.SessionAsync.queue_message, Cinnamon 5.x). No version is
// pinned here on purpose - pinning after the shell has already imported Soup
// only produces warnings, and feature detection is exact.

const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;

var LIBSOUP_MAJOR = Soup.MAJOR_VERSION;
var HAS_SEND_AND_READ = typeof Soup.Session.prototype.send_and_read_async === "function";

var DEFAULT_TIMEOUT_SECONDS = 5;

var _session = null;
var _sessionAsync = null;

function session(timeoutSeconds) {
    let timeout = timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
    if (!_session) {
        _session = HAS_SEND_AND_READ ? new Soup.Session() : new Soup.SessionAsync();
        _session.user_agent = "cinnamon-kilo-agents/1.0";
    }
    try {
        _session.timeout = timeout;
    } catch (e) {
        // Older libsoup without the property - requests then rely on the
        // server answering, which a local kilo server always does.
    }
    return _session;
}

function basicAuth(username, password) {
    let raw = new TextEncoder().encode(username + ":" + password);
    return "Basic " + GLib.base64_encode(raw);
}

function decode(bytes) {
    if (!bytes) {
        return "";
    }
    try {
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return "";
    }
}

// Resolves with { status: <http status int>, body: <string> }.
function httpGet(url, options) {
    let opts = options || {};
    let message = Soup.Message.new("GET", url);
    if (!message) {
        return Promise.reject(new Error("invalid URL: " + url));
    }
    if (opts.username && opts.password) {
        message.request_headers.append("Authorization", basicAuth(opts.username, opts.password));
    }

    if (HAS_SEND_AND_READ) {
        return new Promise(function (resolve, reject) {
            session(opts.timeoutSeconds).send_and_read_async(message, GLib.PRIORITY_DEFAULT, null,
                function (sess, result) {
                    try {
                        let bytes = sess.send_and_read_finish(result);
                        resolve({ status: message.get_status(), body: decode(bytes ? bytes.get_data() : null) });
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    return new Promise(function (resolve, reject) {
        session(opts.timeoutSeconds).queue_message(message, function (sess, msg) {
            try {
                let body = (msg.response_body && msg.response_body.data) ? msg.response_body.data : "";
                resolve({ status: msg.status_code, body: body });
            } catch (e) {
                reject(e);
            }
        });
    });
}

function withQuery(path, params) {
    let pairs = [];
    for (let key in params) {
        if (params[key] === null || params[key] === undefined) {
            continue;
        }
        pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
    }
    return pairs.length ? path + "?" + pairs.join("&") : path;
}

// A single kilo server endpoint.
var KiloClient = class KiloClient {
    constructor(options) {
        let opts = options || {};
        this.host = opts.host || "127.0.0.1";
        this.port = opts.port;
        this.username = opts.username || "kilo";
        this.password = opts.password || null;
        this.timeoutSeconds = opts.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
    }

    get id() {
        return this.host + ":" + this.port;
    }

    url(path) {
        return "http://" + this.host + ":" + this.port + path;
    }

    async getRaw(path, params) {
        return httpGet(this.url(withQuery(path, params || {})), {
            username: this.username,
            password: this.password,
            timeoutSeconds: this.timeoutSeconds,
        });
    }

    async getJson(path, params) {
        let response = await this.getRaw(path, params);
        if (response.status < 200 || response.status >= 300) {
            let error = new Error("HTTP " + response.status + " " + path + " (" + this.id + ")");
            error.status = response.status;
            throw error;
        }
        if (!response.body) {
            return null;
        }
        try {
            return JSON.parse(response.body);
        } catch (e) {
            throw new Error("invalid JSON from " + this.id + path + ": " + e.message);
        }
    }

    // [{ id, worktree, vcs, time: { created, updated } }]
    async projects() {
        let data = await this.getJson("/project");
        return Array.isArray(data) ? data : [];
    }

    // { "<sessionID>": { type: "busy"|"retry"|"offline"|"idle", ... } }
    // A directory is required in practice: without it the server reports only
    // its own instance directory.
    async sessionStatuses(directory) {
        let data = await this.getJson("/session/status", directory ? { directory: directory } : {});
        if (!data || typeof data !== "object") {
            return {};
        }
        return data;
    }

    // [{ id, sessionID, questions: [{ header, question, options }], tool }]
    // Sessions that stopped and wait for the user to answer. This is a different
    // thing from the status `offline` (which is the network-reconnect wait):
    // only the question store knows about it. The endpoint is instance-scoped
    // like /session/status, so it takes the same directory; a server that has no
    // /question answers 404 and the caller treats that as "no questions".
    async questions(directory) {
        let data = await this.getJson("/question", directory ? { directory: directory } : {});
        return Array.isArray(data) ? data : [];
    }

    // [{ id, title, agent, model: {id, providerID}, location: {directory}, ... }]
    async sessions(directory, limit) {
        let data = await this.getJson("/api/session", {
            directory: directory || null,
            limit: limit || 50,
            order: "desc",
        });
        if (!data || !Array.isArray(data.data)) {
            return [];
        }
        return data.data;
    }
};
