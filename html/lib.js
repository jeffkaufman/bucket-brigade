export const LOG_ERROR = 5;
export const LOG_WARNING = 10;
export const LOG_INFO = 15;
export const LOG_DEBUG = 20;
export const LOG_SPAM = 25;
export const LOG_VERYSPAM = 30;

export const LOG_MAX = LOG_VERYSPAM;
export const LOG_DEFAULT = LOG_DEBUG;

export const LOG_LEVELS = [
  [5, "ERROR"],     // Notices of seriou problems
  [10, "WARNING"],  // Notices of minor problems
  [15, "INFO"],     // Infrequent notices of program state
  [20, "DEBUG"],    // Messages that are only useful when debugging
  [25, "SPAM"],     // Messages that happen too often to be useful
  [30, "VERYSPAM"], // Messages that can only bring suffering
];

var LOG_STRINGS = {};
LOG_LEVELS.forEach((level) => {
  LOG_STRINGS[level[0]] = level[1];
});

export var log_level = LOG_DEFAULT;
export function set_log_level(level) {
  log_level = level;
}

function log_level_to_string(level) {
  return LOG_STRINGS[level] || "UNKNOWN_LOG_LEVEL";
}

var session_id;
var context_id;

export function set_logging_session_id(_session_id) {
  if (session_id && (session_id != _session_id)) {
    log(LOG_WARNING, "Changing logging session_id from", session_id, "to", _session_id);
  }
  session_id = _session_id;
}

export function set_logging_context_id(_context_id) {
  if (context_id && (context_id != _context_id)) {
    log(LOG_WARNING, "Changing logging context_id from", context_id, "to", _context_id);
  }
  context_id = _context_id;
}

export function log(level, ...args) {
  var _session_id = session_id || "<no sid>";
  var _context_id = context_id || "<no ctx>";

  if (log_level >= level) {
    console.log("[" + _session_id + "/" + _context_id + "]", Date.now()/1000, log_level_to_string(level) + ":", ...args);
  }
}
