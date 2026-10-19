// Polls every discovered kilo server and merges the answers into one model.
//
// Per server the sweep is:
//   GET /project                       -> candidate project directories
//   GET /session/status[?directory=..] -> per directory, who is not idle
//   GET /question[?directory=..]       -> per directory, who waits for an answer
//   GET /api/session?directory=..      -> title/agent/model/cost for those ids
//
// Status is only reported by the process that runs the agent, and only for
// the directory that process was pointed at, so both the directory sweep and
// the per-server merging matter. Pending questions live in a store of their
// own, which is why they are fetched separately from the status.

const GLib = imports.gi.GLib;

const KiloClient = imports.lib.client.KiloClient;
const Discovery = imports.lib.discovery;

var INACTIVE_STATUSES = ["idle"];

function now() {
    return Date.now();
}

// The short text of a pending question request: the header is meant to be a
// very short label, the question is the full sentence.
function questionText(request) {
    if (!request || !Array.isArray(request.questions) || request.questions.length === 0) {
        return null;
    }
    let first = request.questions[0] || {};
    return first.header || first.question || null;
}

function emptyModel() {
    return { at: 0, servers: [], sessions: [], active: 0, question: 0, busy: 0, retry: 0, offline: 0, errors: [] };
}

// Run `worker` over `items` with at most `limit` in flight, preserving order.
async function mapLimit(items, limit, worker) {
    let results = new Array(items.length);
    let next = 0;
    let workers = [];
    let count = Math.max(1, Math.min(limit, items.length));
    for (let i = 0; i < count; i++) {
        workers.push((async function () {
            while (true) {
                let index = next++;
                if (index >= items.length) {
                    return;
                }
                results[index] = await worker(items[index], index);
            }
        })());
    }
    await Promise.all(workers);
    return results;
}

function isActiveStatus(status) {
    return !!status && INACTIVE_STATUSES.indexOf(status.type) < 0;
}

var Monitor = class Monitor {
    // options: { intervalSeconds, maxSessions, maxDirectories, metadataTtlSeconds,
    //            discoverOptions, onUpdate, onError, log }
    constructor(options) {
        let opts = options || {};
        this.intervalMs = Math.max(500, (opts.intervalSeconds || 2) * 1000);
        this.maxSessions = opts.maxSessions || 20;
        this.maxDirectories = opts.maxDirectories || 60;
        this.metadataTtlMs = (opts.metadataTtlSeconds || 30) * 1000;
        this.discoverOptions = opts.discoverOptions || {};
        this.onUpdate = opts.onUpdate || function () {};
        this.onError = opts.onError || function () {};
        this.log = opts.log || function () {};

        this._timer = 0;
        this._busy = false;
        this._stopped = true;
        this._projectCache = {};
        this._sessionCache = {};
        this._model = emptyModel();
    }

    get running() {
        return !this._stopped;
    }

    get model() {
        return this._model;
    }

    start() {
        if (!this._stopped) {
            return;
        }
        this._stopped = false;
        this.refresh();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.intervalMs, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        this._stopped = true;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    // Force a sweep, ignoring the interval. Resolves with the model.
    async refresh() {
        if (this._stopped || this._busy) {
            return this._model;
        }
        this._busy = true;
        try {
            let servers = Discovery.discover(this.discoverOptions);
            let results = await mapLimit(servers, 4, (server) => this._scanServer(server));
            this._model = this._buildModel(servers, results);
            this.onUpdate(this._model);
            return this._model;
        } catch (e) {
            this.onError(e);
            return this._model;
        } finally {
            this._busy = false;
        }
    }

    // Candidate directories for a server, cached for a while: the list is
    // machine-wide and changes rarely, while status polling runs every tick.
    async _directories(client, server) {
        let cached = this._projectCache[server.id];
        if (cached && now() - cached.at < this.metadataTtlMs) {
            return cached.directories;
        }
        let projects = await client.projects();
        let directories = [];
        for (let i = 0; i < projects.length; i++) {
            let worktree = projects[i] && projects[i].worktree;
            if (worktree && directories.indexOf(worktree) < 0) {
                directories.push(worktree);
            }
        }
        directories.sort(function (a, b) {
            let ua = projectUpdated(projects, a);
            let ub = projectUpdated(projects, b);
            return ub - ua;
        });
        directories = directories.slice(0, this.maxDirectories);
        this._projectCache[server.id] = { at: now(), directories: directories };
        return directories;
    }

    // Session metadata for a directory, refreshed when it is stale or when a
    // newly active session is not in the cached list yet.
    async _sessions(client, server, directory, wantedIds) {
        let key = server.id + "|" + (directory || "*");
        let cached = this._sessionCache[key];
        let complete = cached && wantedIds.every(function (id) { return cached.byId[id]; });
        if (cached && complete && now() - cached.at < this.metadataTtlMs) {
            return cached.byId;
        }
        let list = await client.sessions(directory, this.maxSessions);
        let byId = {};
        for (let i = 0; i < list.length; i++) {
            if (list[i] && list[i].id) {
                byId[list[i].id] = list[i];
            }
        }
        this._sessionCache[key] = { at: now(), byId: byId };
        return byId;
    }

    async _scanServer(server) {
        let client = new KiloClient(server);
        let result = {
            server: server,
            ok: false,
            error: null,
            sessions: [],
            directoryCount: 0,
        };

        let directories = [];
        try {
            directories = await this._directories(client, server);
        } catch (e) {
            // Older servers may not expose /project; status polling still works
            // for the server's own instance directory.
            this.log("kilo-agents: " + server.id + " /project failed: " + e.message);
        }
        result.directoryCount = directories.length;

        let targets = [null].concat(directories);
        let statusResults = await mapLimit(targets, 8, async (directory) => {
            let entry = { directory: directory, statuses: null, questions: [], error: null };
            try {
                entry.statuses = await client.sessionStatuses(directory);
            } catch (e) {
                entry.error = e;
                return entry;
            }
            try {
                entry.questions = await client.questions(directory);
            } catch (e) {
                // Older servers have no /question endpoint. That says nothing
                // about the server being reachable, so it is not an error.
                this.log("kilo-agents: " + server.id + " /question failed: " + e.message);
            }
            return entry;
        });

        let active = [];
        let asked = {};          // session id -> pending question request
        let answered = 0;
        let firstError = null;
        for (let i = 0; i < statusResults.length; i++) {
            let entry = statusResults[i];
            if (entry.error) {
                if (!firstError) {
                    firstError = entry.error;
                }
                continue;
            }
            answered++;
            for (let q = 0; q < entry.questions.length; q++) {
                let request = entry.questions[q];
                if (request && request.sessionID && !asked[request.sessionID]) {
                    asked[request.sessionID] = {
                        id: request.id || null,
                        request: request,
                        directory: entry.directory || server.cwd || null,
                    };
                }
            }
            for (let id in entry.statuses) {
                let status = entry.statuses[id];
                if (!isActiveStatus(status)) {
                    continue;
                }
                active.push({
                    id: id,
                    status: status,
                    directory: entry.directory || server.cwd || null,
                });
            }
        }

        if (answered === 0 && firstError) {
            result.error = firstError.message;
            return result;
        }

        // A question can outlive the status that reported it (or arrive while
        // the session looks idle), so a session with a pending question is in
        // the row even when its status alone would have hidden it.
        let known = {};
        for (let i = 0; i < active.length; i++) {
            known[active[i].id] = true;
        }
        for (let id in asked) {
            if (known[id]) {
                continue;
            }
            active.push({ id: id, status: { type: "question" }, directory: asked[id].directory });
        }

        // One metadata lookup per directory that reported activity, plus the
        // instance directory bucket.
        let buckets = {};
        for (let i = 0; i < active.length; i++) {
            let key = active[i].directory || "*";
            if (!buckets[key]) {
                buckets[key] = { directory: active[i].directory, ids: [] };
            }
            buckets[key].ids.push(active[i].id);
        }
        let metadata = {};
        let bucketKeys = Object.keys(buckets);
        let bucketResults = await mapLimit(bucketKeys, 4, async (key) => {
            let bucket = buckets[key];
            try {
                return { key: key, byId: await this._sessions(client, server, bucket.directory, bucket.ids) };
            } catch (e) {
                this.log("kilo-agents: " + server.id + " session list failed for " + key + ": " + e.message);
                return { key: key, byId: {} };
            }
        });
        for (let i = 0; i < bucketResults.length; i++) {
            let byId = bucketResults[i].byId;
            for (let id in byId) {
                metadata[id] = byId[id];
            }
        }

        for (let i = 0; i < active.length; i++) {
            let entry = active[i];
            let info = metadata[entry.id] || null;
            result.sessions.push(buildSession(entry.id, entry.status, entry.directory, info, server, asked[entry.id] || null));
        }

        result.ok = true;
        return result;
    }

    _buildModel(servers, results) {
        let rank = { question: 0, busy: 1, retry: 2, offline: 3 };
        let rankOf = function (statusType) {
            return rank[statusType] === undefined ? 4 : rank[statusType];
        };

        // One row per session id: two servers can both know about a session
        // (two VS Code windows, a restarted server), and the panel should not
        // list it twice. The most informative status wins.
        let byId = {};
        let order = [];
        let serverModels = [];
        let errors = [];

        for (let i = 0; i < results.length; i++) {
            let result = results[i];
            let server = result.server;
            serverModels.push({
                id: server.id,
                host: server.host,
                port: server.port,
                source: server.source,
                pid: server.pid,
                ok: result.ok,
                error: result.error,
                directoryCount: result.directoryCount,
                activeCount: result.sessions.length,
            });
            if (result.error) {
                errors.push(server.id + ": " + result.error);
            }
            for (let s = 0; s < result.sessions.length; s++) {
                let session = result.sessions[s];
                let existing = byId[session.id];
                if (!existing) {
                    byId[session.id] = session;
                    order.push(session.id);
                    continue;
                }
                if (rankOf(session.statusType) < rankOf(existing.statusType)) {
                    session.reportedBy = (existing.reportedBy || [existing.serverId]).concat([session.serverId]);
                    byId[session.id] = session;
                } else {
                    existing.reportedBy = (existing.reportedBy || [existing.serverId]).concat([session.serverId]);
                }
            }
        }

        let sessions = [];
        let question = 0;
        let busy = 0;
        let retry = 0;
        let offline = 0;
        for (let i = 0; i < order.length; i++) {
            let session = byId[order[i]];
            if (session.statusType === "question") {
                question++;
            } else if (session.statusType === "busy") {
                busy++;
            } else if (session.statusType === "retry") {
                retry++;
            } else if (session.statusType === "offline") {
                offline++;
            }
            sessions.push(session);
        }

        // Most interesting first: a session waiting for an answer, then working,
        // then retrying, then the network wait, then newest.
        sessions.sort(function (a, b) {
            let ra = rankOf(a.statusType);
            let rb = rankOf(b.statusType);
            if (ra !== rb) {
                return ra - rb;
            }
            return (b.updated || 0) - (a.updated || 0);
        });

        // Keep every server's own tally in step with what the menu shows.
        for (let i = 0; i < serverModels.length; i++) {
            serverModels[i].activeCount = sessions.filter(function (session) {
                return session.serverId === serverModels[i].id;
            }).length;
        }

        return {
            at: now(),
            servers: serverModels,
            sessions: sessions,
            active: sessions.length,
            question: question,
            busy: busy,
            retry: retry,
            offline: offline,
            errors: errors,
        };
    }
};

function projectUpdated(projects, worktree) {
    for (let i = 0; i < projects.length; i++) {
        let project = projects[i];
        if (project && project.worktree === worktree && project.time) {
            return project.time.updated || 0;
        }
    }
    return 0;
}

function buildSession(id, status, directory, info, server, pendingQuestion) {
    let question = pendingQuestion || null;
    let model = info && info.model ? (info.model.id || info.model.modelID || null) : null;
    return {
        id: id,
        title: info && info.title ? info.title : id,
        agent: info && info.agent ? info.agent : null,
        model: model,
        directory: (info && info.location && info.location.directory) || directory || null,
        status: status,
        // A pending question is the most interesting thing about a session, so
        // it names the status even when the underlying status is busy.
        statusType: question ? "question" : status.type,
        questionID: question ? question.id : null,
        question: question ? questionText(question.request) : null,
        attempt: status.attempt || null,
        nextAt: status.next || null,
        message: status.message || (status.action && status.action.message) || null,
        requestID: status.requestID || null,
        parentID: info && info.parentID ? info.parentID : null,
        cost: info && typeof info.cost === "number" ? info.cost : null,
        tokens: info && info.tokens ? info.tokens : null,
        created: info && info.time ? info.time.created : null,
        updated: info && info.time ? info.time.updated : null,
        serverId: server.id,
        serverLabel: Discovery.label(server),
        serverSource: server.source,
    };
}
