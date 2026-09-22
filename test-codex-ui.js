// Run against an isolated Pulse instance with --remote-debugging-port=9223.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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
  return { send, evaluate, ws };
}
const targets = () => fetch('http://127.0.0.1:9223/json').then(r => r.json());
(async () => {
  const dash = await connect((await targets()).find(t => t.url.includes('dashboard.html')));
  await dash.evaluate('location.reload()');
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await dash.evaluate("usage.providers.codex.status"), 'ok');
  const id = await dash.evaluate(`(async () => {
    const limit = usage.limits.find(l => l.provider === 'codex' && l.label.includes('Spark'));
    const ws = await window.pulse.pinWidget(limit.kind);
    return ws.at(-1).id;
  })()`);
  await new Promise(r => setTimeout(r, 700));
  let widget;
  for (const target of (await targets()).filter(t => t.url.includes('widget.html'))) {
    const c = await connect(target);
    if (await c.evaluate('window.pulse.widgetId') === id) { widget = c; break; }
    c.ws.close();
  }
  assert.ok(widget);
  assert.equal(await widget.evaluate("document.querySelector('#provider').textContent"), 'CODEX');
  assert.match(await widget.evaluate("document.querySelector('#pct').textContent"), /% left$/);
  assert.equal(await widget.evaluate("document.querySelector('#pill').classList.contains('codex')"), true);
  await widget.evaluate(`window.pulse.widgetTop({ id, top: false })`);
  assert.equal(await widget.evaluate('window.pulse.widgetConfig(id).then(r => r.widget.top)'), false);
  await widget.evaluate(`window.pulse.widgetTop({ id, top: true })`);
  assert.equal(await widget.evaluate('window.pulse.widgetConfig(id).then(r => r.widget.top)'), true);
  for (const [c, name] of [[dash, 'pulse-dashboard'], [widget, 'pulse-codex-widget']]) {
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.TEMP, name + '.png'), Buffer.from(shot.data, 'base64'));
  }
  await widget.evaluate("usage.providers.codex.status = 'offline'; render(false)");
  assert.match(await widget.evaluate("document.querySelector('#pct').textContent"), /^~/);
  await dash.evaluate('window.pulse.widgetClose(' + JSON.stringify(id) + ')');
  dash.ws.close(); widget.ws.close();
  console.log('PASS: live Codex data, pinning, provider styling, remaining percentage, explicit top toggle, stale indicator, removal.');
})().catch(e => { console.error(e); process.exit(1); });
