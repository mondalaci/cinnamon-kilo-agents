// Easing curves for the chip animations.
//
// The animations are driven by the applet itself rather than by Clutter's
// easing, because Cinnamon applies an actor's final value immediately when
// desktop animations are switched off (St.Settings.animations_enabled is false
// by default on many installs, and every ease()/transition is then a no-op).
// A plain frame loop keeps the slide visible regardless, and stays switchable
// through the applet's own setting.
//
// Pure: the test suite checks the curves directly.

var LINEAR = "linear";
var EASE_OUT = "ease-out";     // fast start, gentle arrival - for chips entering
var EASE_IN = "ease-in";       // gentle start, fast exit - for chips leaving

// progress(elapsed, duration, curve) -> 0..1
function progress(elapsed, duration, curve) {
    if (duration <= 0) {
        return 1;
    }
    let t = elapsed / duration;
    if (t <= 0) {
        return 0;
    }
    if (t >= 1) {
        return 1;
    }
    if (curve === EASE_OUT) {
        return t * (2 - t);            // quadratic ease-out
    }
    if (curve === EASE_IN) {
        return t * t;                  // quadratic ease-in
    }
    return t;
}

// value(from, to, progress) -> interpolated value
function value(from, to, p) {
    return from + (to - from) * p;
}

// blinkSchedule(cycles, onMs, offMs) -> [{ at, inverted }]
//
// The order a finished chip flashes before it leaves: it turns inverted for
// onMs, back to normal for offMs, and repeats. The last entry always returns to
// the normal look, so the chip slides away looking like itself.
function blinkSchedule(cycles, onMs, offMs) {
    let steps = [];
    let at = 0;
    let total = Math.max(1, cycles);
    for (let i = 0; i < total; i++) {
        steps.push({ at: at, inverted: true });
        at += onMs;
        steps.push({ at: at, inverted: false });
        at += offMs;
    }
    return steps;
}

// How long a blink schedule takes in total.
function blinkDuration(cycles, onMs, offMs) {
    return Math.max(1, cycles) * (onMs + offMs);
}
