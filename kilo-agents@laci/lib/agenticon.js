// The agent icon: a ready-made robot/agent icon shipped with the applet.
//
// The files in icons/ are third-party icons (Lucide, Tabler, Phosphor,
// Bootstrap Icons, Material Symbols), recoloured to the panel tone. Nothing is
// drawn in code any more: the applet renders the chosen file as a normal
// scalable icon, so it stays smooth at any size.
//
// This module only decides which file to use; it is pure and importable
// outside Cinnamon so the test suite can check the shipped artwork.

var DIR = "icons";

var DEFAULT_ID = "lucide-bot";

// Shown in the settings dropdown, in this order.
var ICONS = [
    { id: "lucide-bot", label: "Lucide bot" },
    { id: "material-smart-toy", label: "Material smart_toy" },
    { id: "tabler-robot", label: "Tabler robot" },
    { id: "phosphor-robot", label: "Phosphor robot" },
    { id: "bootstrap-robot", label: "Bootstrap robot" },
    { id: "material-robot-2", label: "Material robot_2" },
    { id: "lucide-cpu", label: "Lucide cpu" },
    { id: "lucide-brain-circuit", label: "Lucide brain-circuit" },
];

// Theme icon used if the shipped file cannot be loaded.
var FALLBACK_ICON_NAME = "avatar-default-symbolic";

function ids() {
    return ICONS.map(function (icon) { return icon.id; });
}

function has(id) {
    for (let i = 0; i < ICONS.length; i++) {
        if (ICONS[i].id === id) {
            return true;
        }
    }
    return false;
}

function labelFor(id) {
    for (let i = 0; i < ICONS.length; i++) {
        if (ICONS[i].id === id) {
            return ICONS[i].label;
        }
    }
    return ICONS[0].label;
}

// Settings -> dropdown options: { "Lucide bot": "lucide-bot", ... }
function options() {
    let map = {};
    for (let i = 0; i < ICONS.length; i++) {
        map[ICONS[i].label] = ICONS[i].id;
    }
    return map;
}

// Absolute path of the icon file, always inside the applet's icons/ directory.
// An unknown id falls back to the default icon.
function pathFor(id, appletPath) {
    let name = has(id) ? id : DEFAULT_ID;
    return appletPath.replace(/\/+$/, "") + "/" + DIR + "/" + name + ".svg";
}
