const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { normalizeCodex, readRateLimits } = require('./codex-usage');
const Percent = require('./percent');

test('percent display modes read the same way for both providers', () => {
  const claude = { provider: 'claude', percent: 43 };
  const codex = { provider: 'codex', percent: 25, remaining: 75 };
  // original: each provider's native /status convention
  assert.equal(Percent.text(claude, 'original'), '43% used');
  assert.equal(Percent.text(claude, 'original', true), '43%');
  assert.equal(Percent.text(codex, 'original'), '75% left');
  assert.equal(Percent.text(codex, 'original', true), '75% left');
  assert.equal(Percent.bar(claude, 'original'), 43);
  assert.equal(Percent.bar(codex, 'original'), 75);
  // used everywhere
  assert.equal(Percent.text(codex, 'used'), '25% used');
  assert.equal(Percent.text(claude, 'used', true), '43% used');
  assert.equal(Percent.bar(codex, 'used'), 25);
  // left everywhere
  assert.equal(Percent.text(claude, 'left'), '57% left');
  assert.equal(Percent.text(codex, 'left'), '75% left');
  assert.equal(Percent.bar(claude, 'left'), 57);
  // both
  assert.equal(Percent.text(claude, 'both'), '43% used · 57% left');
  assert.equal(Percent.text(codex, 'both', true), '25% used · 75% left');
  assert.equal(Percent.bar(codex, 'both'), 25);
  // notifications read the way the number is shown
  assert.equal(Percent.notice(codex, 'original'), 'down to 75% left');
  assert.equal(Percent.notice(claude, 'left'), 'down to 57% left');
  assert.equal(Percent.notice(codex, 'both'), 'hit 25% used');
  // unknown or missing mode falls back to original; bad numbers clamp
  assert.equal(Percent.normalize(undefined), 'original');
  assert.equal(Percent.text(claude, 'garbage'), '43% used');
  assert.equal(Percent.text({ provider: 'claude', percent: 140 }, 'left'), '0% left');
});
test('dashboard offers every percent mode and the shared module loads in a browser-like scope', () => {
  const html = fs.readFileSync('dashboard.html', 'utf8');
  for (const m of Percent.MODES) assert.match(html, new RegExp(`<option value="${m}"`));
  const scope = { self: {} };
  scope.self.self = scope.self;
  vm.runInNewContext(fs.readFileSync('percent.js', 'utf8'), scope);
  assert.equal(typeof scope.self.PulsePercent.text, 'function');
});

test('all five status windows retain identities, reset times and remaining percentages', () => {
  const window = (mins, used) => ({ windowDurationMins: mins, usedPercent: used, resetsAt: 1800000000 });
  const base = { limitId: 'codex', primary: window(300, 25), secondary: window(10080, 60) };
  const result = normalizeCodex({ rateLimits: base, rateLimitsByLimitId: {
    codex: base, reserve: { limitName: 'gpt-reserve', primary: window(10080, 12) },
    spark: { limitName: 'GPT-5.3-Codex-Spark', primary: window(300, 5), secondary: window(10080, 30) }
  } });
  assert.equal(result.limits.length, 5);
  assert.equal(new Set(result.limits.map(l => l.kind)).size, 5);
  assert.equal(result.limits[0].remaining, 75);
  assert.equal(result.limits[0].resets_at, new Date(1800000000000).toISOString());
  assert.match(result.limits[2].label, /gpt-reserve.*Weekly/);
  assert.match(result.limits[4].label, /Spark.*Weekly/);
});
test('missing windows remain unavailable rather than becoming invented zero usage', () => {
  assert.deepEqual(normalizeCodex({ rateLimits: { primary: null, secondary: null } }).limits, []);
  assert.equal(normalizeCodex({ rateLimits: { primary: { usedPercent: NaN } } }).limits.length, 0);
});
test('missing Codex executable fails cleanly', async () => {
  await assert.rejects(readRateLimits({ executable: 'pulse-nonexistent-executable', timeout: 1000 }));
});
test('renderer scripts parse and quick drag presses cannot change the top setting', () => {
  for (const file of ['dashboard.html', 'widget.html']) {
    const html = fs.readFileSync(file, 'utf8');
    new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  }
  const html = fs.readFileSync('widget.html', 'utf8');
  assert.doesNotMatch(html, /widgetTop\(/);
});
test('top recovery raises only visible pinned windows, without focus calls', () => {
  const source = fs.readFileSync('main.js', 'utf8');
  const fn = source.slice(source.indexOf('function enforceTop('), source.indexOf('function restorePinnedWidgets('));
  const context = {};
  vm.runInNewContext(fn, context);
  const calls = [];
  const win = { isDestroyed: () => false, isVisible: () => true,
    setAlwaysOnTop: (...args) => calls.push(args), moveTop: () => calls.push('raise') };
  context.enforceTop(win, { top: false });
  assert.equal(calls.length, 0);
  context.enforceTop(win, { top: true });
  assert.deepEqual(calls, [[true, 'screen-saver'], 'raise']);
  win.isVisible = () => false;
  context.enforceTop(win, { top: true });
  assert.equal(calls.length, 2);
});
