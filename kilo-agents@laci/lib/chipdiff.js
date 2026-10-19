// Works out how the panel chip row changes between two polls, so the applet can
// animate only what actually appeared or disappeared instead of rebuilding the
// whole row (a rebuild would restart every animation).
//
// The row is described as a list of ids. Sessions use their session id; the two
// non-session chips use reserved ids so they animate like everything else:
//
//   IDLE     - shown when no session is working
//   OVERFLOW - shown when more sessions are working than the chip limit allows
//
// Pure: no Cinnamon, no actor - the test suite covers it directly.

var IDLE = "\u0000idle";
var OVERFLOW = "\u0000overflow";

// previous: ids currently in the row ([] on the first run)
// sessions: the model's sessions, most interesting first
// maxChips: how many sessions fit in the row
function plan(previous, sessions, maxChips) {
    let limit = Math.max(1, maxChips);
    let shown = (sessions || []).slice(0, limit);
    let order = shown.map(function (session) { return session.id; });

    if (shown.length === 0) {
        order.push(IDLE);
    } else if (sessions.length > shown.length) {
        order.push(OVERFLOW);
    }

    let before = previous || [];
    let added = order.filter(function (id) { return before.indexOf(id) < 0; });
    let removed = before.filter(function (id) { return order.indexOf(id) < 0; });

    return {
        order: order,
        added: added,
        removed: removed,
        overflow: Math.max(0, sessions.length - shown.length),
        idle: shown.length === 0,
    };
}

// Reserved id for a session slot, or null when the id is a real session.
function isMarker(id) {
    return id === IDLE || id === OVERFLOW;
}

// What the chip for an id should look like - used to notice that a kept chip
// needs its label or icon refreshed.
function sessionFor(id, sessions) {
    if (isMarker(id)) {
        return null;
    }
    for (let i = 0; i < sessions.length; i++) {
        if (sessions[i].id === id) {
            return sessions[i];
        }
    }
    return null;
}
