// Cinnamon panel applet showing the kilo agents that are working right now.
//
// The panel lists one chip per active session, side by side: a pixel-art
// icon identifying the agent, and the shortened session title next to it.
// The menu has the details (project, agent, model, status, cost) and the
// per-session actions.
//
// Working state lives in each kilo server process rather than in the shared
// database, so the applet discovers every server on the machine and polls
// them all; see lib/discovery.js and lib/monitor.js.

const Applet = imports.ui.applet;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Util = imports.misc.util;

const UUID = "kilo-agents@laci";

// Make this applet's own lib/ directory importable.
const APPLET_PATH = imports.ui.appletManager.appletMeta[UUID].path;
imports.searchPath.unshift(APPLET_PATH);

const Discovery = imports.lib.discovery;
const Format = imports.lib.format;
const AgentIcon = imports.lib.agenticon;
const Monitor = imports.lib.monitor.Monitor;

const REFRESH_ICON = "view-refresh-symbolic";
const SETTINGS_ICON = "preferences-system-symbolic";
const OVERFLOW_STYLE = "kilo-agents-chip-overflow";

// St.Icon multiplies icon_size by the stage scale factor, while the sizes in the
// applet's settings are plain pixels, so undo that here.
function iconSizeFor(pixels) {
    let scale = 1;
    try {
        scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (e) {
        scale = 1;
    }
    return Math.max(1, Math.round(pixels / scale));
}

// The ready-made agent icon, rendered as a scalable icon so it stays smooth at
// any size. Falls back to a theme icon if the shipped file cannot be loaded.
function createAgentIcon(id, size) {
    let path = AgentIcon.pathFor(id, APPLET_PATH);
    let iconSize = iconSizeFor(size);
    try {
        if (Gio.file_new_for_path(path).query_exists(null)) {
            return new St.Icon({
                style_class: "kilo-agents-chip-icon",
                gicon: Gio.icon_new_for_string(path),
                icon_size: iconSize,
            });
        }
        global.logWarning(UUID + ": missing icon " + path + ", using " + AgentIcon.FALLBACK_ICON_NAME);
    } catch (e) {
        global.logError(UUID + ": cannot load icon " + path + ": " + e.message);
    }
    return new St.Icon({
        style_class: "kilo-agents-chip-icon",
        icon_name: AgentIcon.FALLBACK_ICON_NAME,
        icon_type: St.IconType.SYMBOLIC,
        icon_size: iconSize,
    });
}

class KiloAgentsApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._metadata = metadata;
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this._vertical = orientation === St.Side.LEFT || orientation === St.Side.RIGHT;

        this._model = null;
        this._monitor = null;
        this._chipsSignature = null;

        this._chipsBox = new St.BoxLayout({
            style_class: "kilo-agents-chips",
            vertical: this._vertical,
            reactive: false,
        });
        this._chipsBox.set_x_align(Clutter.ActorAlign.CENTER);
        this._chipsBox.set_y_align(Clutter.ActorAlign.CENTER);
        this.actor.add_child(this._chipsBox);

        this._bindSettings(metadata, instanceId);
        this._buildMenu();

        this._log("loading " + UUID + " (libsoup " + imports.lib.client.LIBSOUP_MAJOR + ".x)");
        this._startMonitor();
    }

    _log(message) {
        global.log(message);
    }

    _error(message, error) {
        global.logError(UUID + ": " + message + (error ? ": " + error.message : ""));
    }

    // ---- settings ------------------------------------------------------

    _bindSettings(metadata, instanceId) {
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);

        this.settings.bind("poll-interval", "pollInterval", this._onMonitorSettingsChanged);
        this.settings.bind("max-sessions", "maxSessions", this._onMonitorSettingsChanged);
        this.settings.bind("max-directories", "maxDirectories", this._onMonitorSettingsChanged);
        this.settings.bind("metadata-refresh", "metadataRefresh", this._onMonitorSettingsChanged);
        this.settings.bind("use-daemon", "useDaemon", this._onMonitorSettingsChanged);
        this.settings.bind("daemon-file", "daemonFile", this._onMonitorSettingsChanged);
        this.settings.bind("use-proc", "useProc", this._onMonitorSettingsChanged);
        this.settings.bind("extra-servers", "extraServers", this._onMonitorSettingsChanged);

        this.settings.bind("chips-max", "chipsMax", this._onAppearanceChanged);
        this.settings.bind("chip-title-length", "chipTitleLength", this._onAppearanceChanged);
        this.settings.bind("agent-icon", "agentIcon", this._onAppearanceChanged);
        this.settings.bind("chip-icon-size", "chipIconSize", this._onAppearanceChanged);
        this.settings.bind("chip-show-title", "chipShowTitle", this._onAppearanceChanged);
        this.settings.bind("hide-when-idle", "hideWhenIdle", this._onAppearanceChanged);
        this.settings.bind("tooltip-lines", "tooltipLines", this._onAppearanceChanged);

        this.settings.bind("menu-title-length", "menuTitleLength", this._onAppearanceChanged);
        this.settings.bind("menu-show-model", "menuShowModel", this._onAppearanceChanged);
        this.settings.bind("menu-show-directory", "menuShowDirectory", this._onAppearanceChanged);
        this.settings.bind("menu-show-cost", "menuShowCost", this._onAppearanceChanged);
        this.settings.bind("menu-show-idle-servers", "menuShowIdleServers", this._onAppearanceChanged);

        this.settings.bind("click-action", "clickAction", null);
        this.settings.bind("click-command", "clickCommand", null);
    }

    _onMonitorSettingsChanged() {
        // Restarting is the simplest correct reaction to a discovery or
        // cadence change: it drops the caches and re-scans immediately.
        this._startMonitor();
    }

    _onAppearanceChanged() {
        this._applyModel(this._model);
    }

    // ---- monitor -------------------------------------------------------

    _startMonitor() {
        if (this._monitor) {
            this._monitor.stop();
            this._monitor = null;
        }
        this._monitor = new Monitor({
            intervalSeconds: this.pollInterval,
            maxSessions: this.maxSessions,
            maxDirectories: this.maxDirectories,
            metadataTtlSeconds: this.metadataRefresh,
            discoverOptions: {
                useDaemon: this.useDaemon,
                daemonFile: this.daemonFile ? this.daemonFile : Discovery.defaultDaemonFile(),
                useProc: this.useProc,
                extraServers: this.extraServers,
                log: (message) => this._log(message),
            },
            onUpdate: (model) => this._onModel(model),
            onError: (error) => this._error("monitor failed", error),
            log: (message) => this._log(message),
        });
        this._monitor.start();
    }

    _onModel(model) {
        this._model = model;
        this._applyModel(model);
    }

    // ---- panel ---------------------------------------------------------

    _applyModel(model) {
        this.set_applet_tooltip(Format.tooltipText(model, {
            maxLines: this.tooltipLines,
            showDirectory: true,
        }));
        this._renderChips(model);
        this._renderMenu(model);
    }

    // Rebuilds the chip row only when something visible actually changed -
    // the model is refreshed every couple of seconds.
    _renderChips(model) {
        let sessions = model ? model.sessions : [];
        let shown = sessions.slice(0, Math.max(1, this.chipsMax));
        let signature = [
            this.chipsMax, this.chipTitleLength, this.chipIconSize, this.chipShowTitle, this.hideWhenIdle, this.agentIcon,
            sessions.length,
        ].concat(shown.map((session) =>
            session.id + "|" + session.title + "|" + session.statusType
        )).join("\n");

        if (signature === this._chipsSignature) {
            return;
        }
        this._chipsSignature = signature;

        this._chipsBox.destroy_all_children();
        this._chipsBox.visible = !(sessions.length === 0 && this.hideWhenIdle);

        if (sessions.length === 0) {
            this._chipsBox.add_child(this._chip(null));
            return;
        }

        for (let i = 0; i < shown.length; i++) {
            this._chipsBox.add_child(this._chip(shown[i]));
        }
        if (sessions.length > shown.length) {
            let overflow = new St.Label({
                text: "+" + (sessions.length - shown.length),
                style_class: OVERFLOW_STYLE,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._chipsBox.add_child(overflow);
        }
    }

    // One agent: icon on the left, shortened title on the right. A null
    // session renders the idle chip.
    _chip(session) {
        let chip = new St.BoxLayout({
            style_class: session ? "kilo-agents-chip" : "kilo-agents-chip kilo-agents-chip-idle",
            vertical: this._vertical,
            reactive: false,
        });
        chip.set_y_align(Clutter.ActorAlign.CENTER);
        chip.set_x_align(Clutter.ActorAlign.CENTER);

        chip.add_child(createAgentIcon(this.agentIcon, this.chipIconSize));

        if (session && this.chipShowTitle) {
            let label = new St.Label({
                text: Format.truncate(session.title, this.chipTitleLength),
                style_class: "kilo-agents-chip-title",
            });
            label.set_y_align(Clutter.ActorAlign.CENTER);
            chip.add_child(label);
        }
        return chip;
    }

    // ---- menu ----------------------------------------------------------

    _buildMenu() {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, this._orientation);
        this.menuManager.addMenu(this.menu);

        this._infoItem = new PopupMenu.PopupMenuItem("", { reactive: false });
        this.menu.addMenuItem(this._infoItem);

        this._serversSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._serversSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = new PopupMenu.PopupIconMenuItem("Refresh now", REFRESH_ICON, St.IconType.SYMBOLIC);
        this._refreshItem.connect("activate", () => {
            if (this._monitor) {
                this._monitor.refresh();
            }
        });
        this.menu.addMenuItem(this._refreshItem);

        this._settingsItem = new PopupMenu.PopupIconMenuItem("Applet settings", SETTINGS_ICON, St.IconType.SYMBOLIC);
        this._settingsItem.connect("activate", () => this.configureApplet());
        this.menu.addMenuItem(this._settingsItem);

        this.menu.connect("open-state-changed", (menu, isOpen) => {
            if (isOpen && this._monitor) {
                this._monitor.refresh();
            }
        });
    }

    _infoLabel(model) {
        if (!model) {
            return "Kilo Agents - scanning for servers\u2026";
        }
        let parts = [model.active + " active"];
        if (model.busy) {
            parts.push(model.busy + " working");
        }
        if (model.retry) {
            parts.push(model.retry + " retrying");
        }
        if (model.offline) {
            parts.push(model.offline + " awaiting answer");
        }
        parts.push(Format.serverSummary(model));
        return "Kilo Agents - " + parts.join(", ");
    }

    _renderMenu(model) {
        this._infoItem.setLabel(this._infoLabel(model));
        this._serversSection.removeAll();

        if (!model) {
            return;
        }

        for (let i = 0; i < model.servers.length; i++) {
            let server = model.servers[i];
            let sessions = model.sessions.filter((session) => session.serverId === server.id);
            if (sessions.length === 0 && !server.error && !this.menuShowIdleServers) {
                continue;
            }
            this._serversSection.addMenuItem(this._serverItem(server, sessions));
        }

        if (model.servers.length === 0) {
            this._serversSection.addMenuItem(new PopupMenu.PopupMenuItem("No kilo servers found", { reactive: false }));
        }
    }

    _serverItem(server, sessions) {
        let title = server.id;
        if (sessions.length > 0) {
            title += "  \u2014  " + sessions.length + " active";
        } else if (server.error) {
            title += "  \u2014  unreachable";
        } else {
            title += "  \u2014  idle";
        }
        let item = new PopupMenu.PopupSubMenuMenuItem(title);
        if (server.pid) {
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem("pid " + server.pid + " \u00b7 " + server.directoryCount + " projects", { reactive: false }));
        }
        if (server.error) {
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem(Format.truncate(server.error, 70), { reactive: false }));
        }
        for (let i = 0; i < sessions.length; i++) {
            item.menu.addMenuItem(this._sessionItem(sessions[i]));
        }
        return item;
    }

    _sessionItem(session) {
        let glyph = session.statusType === "busy" ? "\u25b6" : (session.statusType === "retry" ? "\u21bb" : "?");
        let label = glyph + "  " + Format.sessionMenuLabel(session, {
            maxTitleLength: this.menuTitleLength,
            showAgent: true,
            showModel: this.menuShowModel,
        });
        let item = new PopupMenu.PopupSubMenuMenuItem(label);

        item.menu.addMenuItem(new PopupMenu.PopupMenuItem(Format.truncate(session.title, 80), { reactive: false }));
        if (this.menuShowDirectory && session.directory) {
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem(session.directory, { reactive: false }));
        }
        item.menu.addMenuItem(new PopupMenu.PopupMenuItem("session " + session.id, { reactive: false }));
        item.menu.addMenuItem(new PopupMenu.PopupMenuItem(Format.statusDetail(session), { reactive: false }));
        if (session.agent || session.model) {
            let bits = [];
            if (session.agent) {
                bits.push("agent " + session.agent);
            }
            let model = Format.modelLabel(session.model);
            if (model) {
                bits.push("model " + model);
            }
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem(bits.join(" \u00b7 "), { reactive: false }));
        }
        if (session.updated) {
            item.menu.addMenuItem(new PopupMenu.PopupMenuItem("updated " + Format.elapsedSince(session.updated), { reactive: false }));
        }
        if (this.menuShowCost) {
            let bits = [];
            let cost = Format.formatCost(session.cost);
            if (cost) {
                bits.push("cost " + cost);
            }
            let tokens = Format.tokenCount(session);
            if (tokens) {
                bits.push(tokens + " tokens");
            }
            if (bits.length) {
                item.menu.addMenuItem(new PopupMenu.PopupMenuItem(bits.join(" \u00b7 "), { reactive: false }));
            }
        }
        item.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let copyItem = new PopupMenu.PopupIconMenuItem("Copy session ID", "edit-copy-symbolic", St.IconType.SYMBOLIC);
        copyItem.connect("activate", () => this._copyToClipboard(session.id));
        item.menu.addMenuItem(copyItem);

        // The "copy" action is already the row above - only offer a separate
        // command row when a command is configured.
        if (this.clickAction === "command") {
            let actionItem = new PopupMenu.PopupIconMenuItem("Run command for this session", "system-run-symbolic", St.IconType.SYMBOLIC);
            actionItem.connect("activate", () => this._activateSession(session));
            item.menu.addMenuItem(actionItem);
        }

        return item;
    }

    // ---- actions -------------------------------------------------------

    // Deliberately silent: the applet never raises desktop notifications.
    _copyToClipboard(text) {
        try {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        } catch (e) {
            this._error("clipboard write failed", e);
        }
    }

    _activateSession(session) {
        if (this.clickAction === "copy") {
            this._copyToClipboard(session.id);
            return;
        }
        if (this.clickAction !== "command") {
            return;
        }
        let command = this._expand(this.clickCommand, session);
        if (!command) {
            return;
        }
        try {
            Util.spawnCommandLine(command);
        } catch (e) {
            this._error("cannot run " + command, e);
        }
    }

    _expand(template, session) {
        if (!template) {
            return "";
        }
        let values = {
            id: session.id,
            title: session.title,
            dir: session.directory || "",
            agent: session.agent || "",
            model: Format.modelLabel(session.model) || "",
            status: session.statusType,
        };
        return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : values[key]));
    }

    // ---- applet entry points -------------------------------------------

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_middle_clicked() {
        if (this._monitor) {
            this._monitor.refresh();
        }
    }

    on_applet_removed_from_panel() {
        if (this._monitor) {
            this._monitor.stop();
            this._monitor = null;
        }
        if (this.settings) {
            this.settings.finalize();
        }
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new KiloAgentsApplet(metadata, orientation, panelHeight, instanceId);
}
