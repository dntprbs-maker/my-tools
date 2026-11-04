const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codexWindows } = require('../www/codex-windows.js');
const five = { limit_window_seconds: 18000, used_percent: 24, reset_at: 1800000000 };
const week = { limit_window_seconds: 604800, used_percent: 11, reset_at: 1800500000 };
test('weekly-only primary belongs to weekly; absent five-hour is unknown', () => {
  const r = codexWindows({ primary_window: week });
  assert.equal(r.five.used, null);
  assert.equal(r.five.reset, null);
  assert.equal(r.week.used, 11);
  assert.equal(r.week.reset.getTime(), 1800500000000);
});
test('both slot orders preserve duration labels', () => {
  for (const [primary_window, secondary_window] of [[five, week], [week, five]]) {
    const r = codexWindows({ primary_window, secondary_window });
    assert.equal(r.five.used, 24);
    assert.equal(r.week.used, 11);
  }
});
test('unknown duration and missing windows stay unknown', () => {
  for (const input of [undefined, {}, { primary_window: { used_percent: 11 } }, { primary_window: { ...week, limit_window_seconds: 3600 } }]) {
    assert.deepEqual(codexWindows(input), { five: { used: null, reset: null }, week: { used: null, reset: null } });
  }
});
test('conflicting duplicate durations cannot choose a value', () => {
  assert.equal(codexWindows({ primary_window: week, secondary_window: { ...week, used_percent: 80 } }).week.used, null);
});
test('zero usage is valid, missing or malformed reset stays unknown', () => {
  for (const reset_at of [null, 'invalid']) {
    const r = codexWindows({ primary_window: { ...week, used_percent: 0, reset_at } });
    assert.equal(r.week.used, 0);
    assert.equal(r.week.reset, null);
  }
});
