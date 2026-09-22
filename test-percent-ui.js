// Run against an isolated Pulse instance with --remote-debugging-port=9223 and
// PULSE_DATA_DIR / PULSE_PROFILE_DIR set (the same env for this script).
// Flips the percent display through every mode and checks dashboard rows,
// widget pills and the saved setting all agree. Screenshots land in %TEMP%.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 10000);
    const listener = event => {
      const message = JSON.parse(event.data);
      if (message.id !== mid) return;
      clearTimeout(timer); ws.removeEventListener('message', listener);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const shot = async name => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.TEMP || '.', name + '.png'), Buffer.from(s.data, 'base64'));
  };
  return { send, evaluate, shot, ws };
}
const targets = () => fetch('http://127.0.0.1:9223/json').then(r => r.json());
const MODES = ['original', 'used', 'left', 'both'];

(async () => {
  const dash = await connect((await targets()).find(t => t.url.includes('dashboard.html')));
  for (let i = 0; i < 80; i++) {
    if (await dash.evaluate("!!usage && usage.limits.some(l => l.provider === 'claude') && usage.limits.some(l => l.provider === 'codex')")) break;
    await sleep(500);
  }
  const rows = () => dash.evaluate(`[...document.querySelectorAll('.limitRow')].map(r => ({ name: r.querySelector('.name').textContent, pct: r.querySelector('.pct').textContent, bar: r.querySelector('.fill').style.width }))`);
  const setMode = async m => {
    await dash.evaluate(`(() => { const s = document.querySelector('#setPercent'); s.value = ${JSON.stringify(m)}; s.dispatchEvent(new Event('change')); return 'ok'; })()`);
    await sleep(500);
  };

  const ids = await dash.evaluate(`(async () => {
    const c = usage.limits.find(l => l.provider === 'claude'), x = usage.limits.find(l => l.provider === 'codex');
    const a = await window.pulse.pinWidget(c.kind); const b = await window.pulse.pinWidget(x.kind);
    return [a.at(-1).id, b.at(-1).id];
  })()`);
  await sleep(900);
  const widgets = [];
  for (const t of (await targets()).filter(t => t.url.includes('widget.html'))) {
    const c = await connect(t);
    if (ids.includes(await c.evaluate('window.pulse.widgetId'))) widgets.push(c); else c.ws.close();
  }
  assert.equal(widgets.length, 2, 'both pinned widgets found');

  const out = {};
  for (const m of MODES) {
    await setMode(m);
    assert.equal(await dash.evaluate('settings.percentMode'), m);
    const w = [];
    for (const c of widgets) w.push(await c.evaluate("document.querySelector('#provider').textContent + ' ' + document.querySelector('#pct').textContent + ' bar=' + document.querySelector('#fill').style.width"));
    out[m] = { rows: await rows(), widgets: w };
    await dash.shot('pulse-dash-' + m);
    for (const [i, c] of widgets.entries()) await c.shot(`pulse-widget-${i}-${m}`);
  }
  const claude = m => out[m].rows.find(r => r.name.startsWith('Claude'));
  const codex = m => out[m].rows.find(r => r.name.startsWith('Codex'));
  assert.match(claude('original').pct, /% used$/); assert.match(codex('original').pct, /% left$/);
  assert.match(claude('used').pct, /% used$/); assert.match(codex('used').pct, /% used$/);
  assert.match(claude('left').pct, /% left$/); assert.match(codex('left').pct, /% left$/);
  assert.match(claude('both').pct, /^\d+% used · \d+% left$/); assert.match(codex('both').pct, /^\d+% used · \d+% left$/);
  assert.equal(parseInt(codex('used').pct) + parseInt(codex('left').pct), 100);
  assert.equal(parseInt(claude('used').pct) + parseInt(claude('left').pct), 100);
  assert.equal(codex('used').bar, parseInt(codex('used').pct) + '%');
  assert.equal(codex('left').bar, parseInt(codex('left').pct) + '%');
  assert.ok(out.used.widgets.every(w => /% used bar=/.test(w)), 'widgets read used');
  assert.ok(out.left.widgets.every(w => /% left bar=/.test(w)), 'widgets read left');
  assert.ok(out.both.widgets.every(w => /% used · \d+% left/.test(w)), 'widgets read both');
  assert.ok(out.original.widgets.some(w => /^CLAUDE \d+% bar=/.test(w)), 'claude widget keeps bare % in original');
  assert.ok(out.original.widgets.some(w => /^CODEX \d+% left bar=/.test(w)), 'codex widget keeps % left in original');
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.PULSE_DATA_DIR, 'pulse.json'), 'utf8'));
  assert.equal(saved.settings.percentMode, 'both', 'mode persisted');

  await setMode('original');
  for (const id of ids) await dash.evaluate('window.pulse.widgetClose(' + JSON.stringify(id) + ')');
  console.log(JSON.stringify(out, null, 1));
  console.log('PASS: percent display modes agree across dashboard rows, widget pills and saved settings.');
  dash.ws.close(); for (const c of widgets) c.ws.close();
})().catch(e => { console.error(e); process.exit(1); });
