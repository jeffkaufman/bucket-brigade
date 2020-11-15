var log_counts = {}
export function log_every(n, tag, ...args) {
  if (tag.constructor != String) {
    console.error("In log_every, tag must be a string! Got:", n, tag, args);
    return;
  }

  if (log_counts[tag] === undefined) {
    log_counts[tag] = 0;
  }
  if (log_counts[tag] % n == 0) {
    console.debug("<" + tag + "/" + n + ">", ...args);
  }
  log_counts[tag]++;
}

export function check(condition, message, ...rest) {
  if (!condition) {
    console.error(message, ...rest);
    throw new Error(message);
  }
}
