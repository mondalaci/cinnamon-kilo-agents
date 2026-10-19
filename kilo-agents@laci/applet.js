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
const GLib = imports.gi.GLib;
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
const ChipDiff = imports.lib.chipdiff;
const Easing = imports.lib.easing;
const Monitor = imports.lib.monitor.Monitor;

const REFRESH_ICON = "view-refresh-symbolic";
const SETTINGS_ICON = "preferences-system-symbolic";
const OVERFLOW_STYLE = "kilo-agents-chip-overflow";
const IN_ANIMATION_MS = 250;
const OUT_ANIMATION_MS = 200;
const BLINK_CYCLES = 3;
const BLINK_ON_MS = 150;
const BLINK_OFF_MS = 150;
const FRAME_MS = 16;
const INVERTED_STYLE = "kilo-agents-chip-inverted";
const INVERTED_TEXT_COLOR = "#1a1a1a";

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
        this._animations = [];   // frame timers of running chip animations
        this._chips = {};        // session id (or marker id) -> chip actor
        this._chipIds = [];      // the row as currently drawn, left to right
        this._chipsAppearance = null;
        this._chipsRendered = false;

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
        this.settings.bind("animate-chips", "animateChips", this._onAppearanceChanged);
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

    // The chip row is diffed against the previous poll and animated: a session
    // that starts slides in, one that finishes slides out, and chips that stay
    // are only moved and refreshed.
    _renderChips(model) {
        let sessions = model ? model.sessions : [];
        let appearance = [this.chipsMax, this.chipTitleLength, this.chipIconSize, this.chipShowTitle,
                          this.hideWhenIdle, this.agentIcon].join("|");

        if (appearance !== this._chipsAppearance) {
            // A visual setting changed: rebuild instantly, nothing to animate.
            this._chipsAppearance = appearance;
            this._dropChips();
        }

        let plan = ChipDiff.plan(this._chipIds, sessions, this.chipsMax);
        // the first render is not a transition: nothing to animate yet
        let animate = this.animateChips && this._chipsRendered;

        for (let i = 0; i < plan.removed.length; i++) {
            this._removeChip(plan.removed[i], animate);
        }
        for (let index = 0; index < plan.order.length; index++) {
            let id = plan.order[index];
            let actor = this._chips[id];
            let session = ChipDiff.sessionFor(id, sessions);
            if (!actor) {
                actor = this._createChip(id, session, plan.overflow);
                this._chips[id] = actor;
                this._chipsBox.add_child(actor);
                this._animateIn(actor, id, animate);
            } else {
                this._refreshChip(actor, id, session, plan.overflow);
            }
            this._chipsBox.set_child_at_index(actor, index);
        }
        this._chipIds = plan.order.slice();
        this._chipsRendered = true;
        this._chipsBox.visible = !(sessions.length === 0 && this.hideWhenIdle);
    }

    _dropChips() {
        for (let id in this._chips) {
            this._chips[id].destroy();
        }
        this._chips = {};
        this._chipIds = [];
    }

    _createChip(id, session, overflow) {
        if (id === ChipDiff.IDLE) {
            return this._chip(null);
        }
        if (id === ChipDiff.OVERFLOW) {
            let box = new St.BoxLayout({ style_class: "kilo-agents-chip", reactive: false });
            box.set_y_align(Clutter.ActorAlign.CENTER);
            box.add_child(new St.Label({
                text: "+" + overflow,
                style_class: OVERFLOW_STYLE,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }
        return this._chip(session);
    }

    // Keeps a chip that is still there in step with its session.
    _refreshChip(actor, id, session, overflow) {
        if (id === ChipDiff.OVERFLOW) {
            let label = actor.get_children()[0];
            label.set_text("+" + overflow);
            return;
        }
        if (!session) {
            return;
        }
        let kids = actor.get_children();
        let label = kids[kids.length - 1];
        let wanted = Format.truncate(session.title, this.chipTitleLength);
        if (this.chipShowTitle && label && label.get_text() !== wanted) {
            label.set_text(wanted);
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
        chip._kiloIcon = chip.get_children()[0];
        chip._kiloIconPath = AgentIcon.pathFor(this.agentIcon, APPLET_PATH);
        chip._kiloIconPathInverted = AgentIcon.invertedPathFor(this.agentIcon, APPLET_PATH);

        if (session && this.chipShowTitle) {
            let label = new St.Label({
                text: Format.truncate(session.title, this.chipTitleLength),
                style_class: "kilo-agents-chip-title",
            });
            label.set_y_align(Clutter.ActorAlign.CENTER);
            chip.add_child(label);
            chip._kiloLabel = label;
        }
        return chip;
    }

    // The "negative" of a chip: dark artwork on the panel's text tone. Used for
    // the three flashes a finished chip makes before it leaves.
    _setInverted(actor, inverted) {
        if (inverted) {
            actor.add_style_class_name(INVERTED_STYLE);
        } else {
            actor.remove_style_class_name(INVERTED_STYLE);
        }
        let icon = actor._kiloIcon;
        if (icon && actor._kiloIconPath) {
            try {
                icon.set_gicon(Gio.icon_new_for_string(inverted ? actor._kiloIconPathInverted : actor._kiloIconPath));
            } catch (e) {
                this._error("cannot switch the chip icon", e);
            }
        }
        let label = actor._kiloLabel;
        if (label) {
            if (inverted) {
                label.set_style("color: " + INVERTED_TEXT_COLOR + ";");
            } else {
                label.set_style(null);
            }
        }
    }

    // ---- animation -----------------------------------------------------

    // Slides a chip in from the left, fading it in.
    _animateIn(actor, id, animate) {
        if (!animate) {
            return;
        }
        let distance = id === ChipDiff.IDLE ? 0 : this._slideDistance();
        actor.set_opacity(0);
        actor.set_translation(-distance, 0, 0);
        this._slide(actor, {
            translationFrom: -distance,
            translationTo: 0,
            opacityFrom: 0,
            opacityTo: 255,
            duration: IN_ANIMATION_MS,
            curve: Easing.EASE_OUT,
        });
    }

    // Removes a chip. A session that finished flashes inverted three times
    // first, then slides out; the idle/overflow markers just slide out.
    _removeChip(id, animate) {
        let actor = this._chips[id];
        delete this._chips[id];
        if (!actor) {
            return;
        }
        if (!animate) {
            actor.destroy();
            return;
        }

        if (ChipDiff.isMarker(id) || id.indexOf("ses_") !== 0) {
            this._slideOut(actor, id);
            return;
        }
        this._flashThenSlideOut(actor, id);
    }

    // Blinks the chip inverted and then hands over to the exit slide.
    _flashThenSlideOut(actor, id) {
        let self = this;
        let schedule = Easing.blinkSchedule(BLINK_CYCLES, BLINK_ON_MS, BLINK_OFF_MS);
        let started = GLib.get_monotonic_time() / 1000;
        let step = 0;

        let tick = function () {
            let elapsed = GLib.get_monotonic_time() / 1000 - started;
            while (step < schedule.length && schedule[step].at <= elapsed) {
                let entry = schedule[step];
                step++;
                try {
                    self._setInverted(actor, entry.inverted);
                } catch (e) {
                    // the actor is gone: stop flashing and let it be
                    return GLib.SOURCE_REMOVE;
                }
            }
            if (step >= schedule.length) {
                self._slideOut(actor, id);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };

        // start inverted immediately, then let the frames drive the rest
        this._setInverted(actor, schedule[0].inverted);
        step = 1;
        let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, tick);
        this._animations.push(timer);
    }

    // Slides a chip out to the left, fading it out, then destroys it. The chips
    // to its right are pulled left by the same width for the duration, so the
    // row does not jump when the actor finally disappears.
    _slideOut(actor, id) {
        let index = this._chipIds.indexOf(id);
        let width = actor.get_width() + this._chipSpacing();
        let following = [];
        if (index >= 0 && width > 0) {
            for (let i = index + 1; i < this._chipIds.length; i++) {
                let sibling = this._chips[this._chipIds[i]];
                if (!sibling) {
                    continue;
                }
                following.push(sibling);
                this._slide(sibling, {
                    translationFrom: sibling.translation_x,
                    translationTo: sibling.translation_x - width,
                    opacityFrom: sibling.opacity,
                    opacityTo: sibling.opacity,
                    duration: OUT_ANIMATION_MS,
                    curve: Easing.EASE_IN,
                });
            }
        }

        this._slide(actor, {
            translationFrom: actor.translation_x,
            translationTo: -this._slideDistance(),
            opacityFrom: actor.opacity,
            opacityTo: 0,
            duration: OUT_ANIMATION_MS,
            curve: Easing.EASE_IN,
            onComplete: function () {
                actor.destroy();
                // the layout drops the freed slot in the same frame, so the
                // shift can be given back without moving anything on screen
                for (let i = 0; i < following.length; i++) {
                    following[i].set_translation(0, 0, 0);
                }
            },
        });
    }

    // Moves a chip right or left by taking the space back over several frames.
    // Cinnamon skips Clutter easing when desktop animations are off, so the
    // interpolation is done here.
    _slide(actor, options) {
        let duration = Math.max(1, options.duration);
        let started = GLib.get_monotonic_time() / 1000;
        let self = this;
        let id = 0;

        // keeps the timer registry honest, so removing the applet never tries to
        // cancel a timeout that already finished
        let forget = function () {
            let index = self._animations.indexOf(id);
            if (index >= 0) {
                self._animations.splice(index, 1);
            }
        };

        let step = function () {
            let elapsed = GLib.get_monotonic_time() / 1000 - started;
            let p = Easing.progress(elapsed, duration, options.curve);
            try {
                actor.set_translation(Easing.value(options.translationFrom, options.translationTo, p), 0, 0);
                actor.set_opacity(Math.round(Easing.value(options.opacityFrom, options.opacityTo, p)));
            } catch (e) {
                // the actor went away underneath us (applet removed, rebuild)
                forget();
                return GLib.SOURCE_REMOVE;
            }
            if (elapsed >= duration) {
                forget();
                if (options.onComplete) {
                    options.onComplete();
                }
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };

        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, step);
        this._animations.push(id);
    }

    _slideDistance() {
        return Math.max(24, this.chipIconSize + 12);
    }

    _chipSpacing() {
        try {
            let spacing = this._chipsBox.get_theme_node().get_length("spacing");
            return spacing > 0 ? spacing : 8;
        } catch (e) {
            return 8;
        }
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
        for (let i = 0; i < this._animations.length; i++) {
            GLib.source_remove(this._animations[i]);
        }
        this._animations = [];
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
