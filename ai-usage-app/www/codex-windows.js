// Use the actual duration, never primary/secondary position, to label a limit.
function codexWindows(rateLimit) {
  const windows = ['primary_window', 'secondary_window'].map(key => (rateLimit || {})[key]).filter(w => w && typeof w === 'object');
  const pick = seconds => {
    const matches = windows.filter(w => Number(w.limit_window_seconds) === seconds);
    const w = matches.length === 1 ? matches[0] : null;
    const reset = w && w.reset_at ? new Date(w.reset_at * 1000) : null;
    return {
      used: w && w.used_percent != null ? w.used_percent : null,
      reset: reset && Number.isFinite(reset.getTime()) ? reset : null,
    };
  };
  return { five: pick(18000), week: pick(604800) };
}
if (typeof module !== 'undefined') module.exports = { codexWindows };
