// The agent icon: one ready-made robot icon shipped with the applet.
//
// icons/lucide-bot.svg is Lucide's "bot" (ISC), recoloured to the panel tone,
// and icons/lucide-bot-inverted.svg is the same artwork in the panel background
// tone, which a finished chip flashes. Nothing is drawn in code: the applet
// renders the file as a normal scalable icon so it stays smooth at any size.
//
// To use a different icon, drop an SVG with the same file name into icons/ (and
// its inverse twin) - there is deliberately no icon chooser in the settings.
//
// This module only resolves paths; it is pure and importable outside Cinnamon
// so the test suite can check the shipped artwork.

var ICON_FILE = "lucide-bot";
var DIR = "icons";
var INVERTED_SUFFIX = "-inverted";

// Theme icon used if the shipped file cannot be loaded.
var FALLBACK_ICON_NAME = "avatar-default-symbolic";

// Absolute path of the icon file, always inside the applet's icons/ directory.
function pathFor(appletPath) {
    return appletPath.replace(/\/+$/, "") + "/" + DIR + "/" + ICON_FILE + ".svg";
}

// Same, for the inverted variant shown while a finished chip blinks.
function invertedPathFor(appletPath) {
    return appletPath.replace(/\/+$/, "") + "/" + DIR + "/" + ICON_FILE + INVERTED_SUFFIX + ".svg";
}
